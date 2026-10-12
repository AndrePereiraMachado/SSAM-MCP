# Fase 3: a bridge O11 fina (desenho)

Este documento é o contrato das faixas paralelas da fase 3. Ele parte de `servidor/fase2` (commit `acba66d8`), cujo
contrato é `docs/FASE2-AGENTE.md` (citado aqui como FASE2). Cada afirmação sobre o código atual foi conferida nos
arquivos citados. Nenhuma faixa edita este documento: um desvio necessário vai na resposta final da faixa, para o
orquestrador. Revisão 1: aplica a crítica do desenho (rastreabilidade na §11).

## 0. Decisões em uma página

- **O problema.** No hospedado O11 o pacote do agente leva `bin\o11\bridge\Anvil.Bridge.dll` e também `Anvil.Core.dll`
  (o kernel inteiro, mais `Anvil.CSharp.dll` e `Esprima.dll`), porque `kernel/src/Anvil.Bridge/Anvil.Bridge.csproj:42`
  tem `ProjectReference ..\Anvil.Core` (FASE2 §1, §6.2, §11; `scripts/agent-pack.ps1:145/158/164`).
- **A bridge fina** é um projeto novo, `kernel/src/Anvil.Bridge.Thin/Anvil.Bridge.Thin.csproj`, que referencia SÓ as
  DLLs do Service Studio (`Private=false`) e a BCL: nenhum `ProjectReference`, nenhum `PackageReference`. O assembly
  tem o MESMO nome da bridge completa (`Anvil.Bridge`, arquivo `Anvil.Bridge.dll`, entrada
  `Anvil.Bridge.Server.Start(int)` e, a do gancho de release, `Start(int, string, string)`), de modo que
  `Anvil.RuntimeHook`, `Anvil.Connect`, `Anvil.StartupHook` e `Anvil.Inject` continuam sem mudança (§2.1; o pacote
  hospedado usa o gancho de desenvolvimento: limite na §9). Fina e completa se distinguem em tempo de execução por
  `flavor:"thin"` em `ping` e `bridge_manifest` e, no `describe` do `Anvil.Connect`, por `corePath` nulo. A fina entra
  em `kernel/Anvil.slnx`, para que a compilação do kernel pegue quebra nos arquivos compartilhados.
- **O fio não muda.** Protocolo 2, uma linha JSON por pedido (`{method, params, authorization}` →
  `{success, data, error, executed?}`). O relay O11 da fase 2, o `AgentExecutor` e o espelho continuam como estão. A
  fina tem 20 verbos (21 desde a nona entrega, com `refresh_references`, §14): saem `login`, `export_modules`, `export_status`, `find_element` e `get_flow_nodes`;
  `merge_from_oml` ganha o parâmetro `reference_plan`, obrigatório quando há base (§3).
- **O que era lógica do kernel dentro do Studio vai para o servidor**, num decorador do `BridgeClient` do kernel
  (`kernel/src/Anvil.Core/Adapters.SS11/ThinBridge.cs`), ligado só quando `ANVIL_BRIDGE_FLAVOR=thin`, variável que só
  `hostedSpawnEnv('o11')` põe: o plano de assinaturas de produtor (`ReferenceSignatureMerge.Analyze`) calculado sobre
  base e candidato, `find_element` calculado sobre uma captura, e a recusa de `login`, `export_*` e `get_flow_nodes`
  (sem chamador no kernel nem na fachada). Toda falha do decorador antes de enviar é `executed:false` (§4).
- **Refresh de referências e leitura nativa de dependências já rodam no servidor** (CLI `anvil`, sobre
  `environment_session`). A fina só precisa das primitivas de sessão `download`, `signature`, `referenceable`,
  `versions`, `modules` (§1.4).
- **O modo local do dono fica idêntico:** continua com a bridge completa (`Anvil.Bridge` + `Anvil.Core`) e com o kernel
  local sem `ANVIL_BRIDGE_FLAVOR`. A bridge completa só recebe edições mecânicas, em arquivos sem overlay de release,
  para que 14 arquivos (entre eles toda a lista fechada do Service Center) sejam compartilhados por link com a fina, sem
  cópia que possa divergir; `ScProtocol.cs` e `ScSecrets.cs`, que têm overlay de release, vão como cópias idênticas
  provadas por teste (§2.2, §2.3, §5).
- **Conhecimento do produto que ainda vai na fina, para o dono aceitar sabendo** (nenhum é o kernel; tudo é código C#
  sem ofuscação, descompilável):
  - a guarda do merge de assinaturas (`ReferenceSelections.cs`, cerca de 150 linhas): a seleção nativa de
    `ReferenceHash` (`IgnoreForDiff`, raízes explícitas, `MergeAction.Update`), a conferência de que o plano cobre os
    bytes carregados e a metade de `Analyze` que lê o modelo vivo (identidade do produtor, chave, tipo e hash da
    referência viva). O julgamento da assinatura do candidato fica no servidor (§3.3, pergunta aberta 1);
  - a tabela de classificação de diálogos de `DialogPolicy` (cópia em `BridgeKit`), com as dicas do dev que citam
    `python scripts/cdp_pages.py` (a fachada já as reescreve: `translateDialogHint`, `o11-studio.test.mjs:476-477`);
  - as primitivas de ambiente: `GetReferenceDetails` por REST via reflexão com recaída em SOAP, `TemplateManager` por
    REST, as `PublishOptions` de `Start1CP` (§3.6);
  - cerca de 107 KB de fonte do Service Center (`ScOperations`, `ScProtocol`, `ScSecrets`, `ScWebHandler`,
    `ScApiHandler`, `ScVault`): listas fechadas, guarda de escrita e redação. Ficam do lado do cliente de propósito:
    são a fronteira de segurança sobre a sessão e o cofre DELE.
  A fina não passa pela tecelagem de licença (`scripts/release/license/weave-spec.json:13` só mira o `Server.cs` da
  completa) nem por ofuscação. No hospedado isso é aceitável: a licença e a revogação (token) estão no servidor, e a
  fina sozinha não faz nada útil sem ele.
- **Pacote:** `bin\o11\bridge` leva só `Anvil.Bridge.dll` (a fina) e o `.deps.json` dela; `node.exe` vai por padrão e
  SÓ com a licença dele (sem `LICENSE`, o pacote é recusado); uma varredura de propriedade intelectual lê o ZIP pronto
  e recusa o pacote se aparecer assembly ou namespace do kernel, ou texto de cliente da lista
  `scripts/release/client-content.json` fora de uma tabela fixa de exceções conhecidas (§6.4). A bridge ODC deixa de
  embutir o tipo `Anvil.Core.OdcPublicSignature` (§6.5).
- **Fixture neutra:** `kernel/tests/fixtures/odc/blank-crossdevice.oml`, gerada offline por
  `anvil-odc create-blank --kind CrossDevice` (sem tenant, sem template, sem Studio). No hospedado,
  `ssam_job {lane:"odc"}` sem `base` roda nela (sai `HOSTED_BASE_REQUIRED`), e toda resposta hospedada perde a
  evidência de jobs cuja base é a captura de terceiro `wrightflood-personal-r8.oml` (§7.2).
- **Quatro faixas** com donos de arquivo exclusivos: `thin`, `server`, `pack`, `neutral` (§8).

## 1. Inventário

### 1.1 Regra de classificação

- **(a) primitiva mantida na fina:** só acontece dentro do processo do Studio (UI viva, modelo aberto, sessão de login
  do cliente, cofre do Windows do cliente) e não carrega decisão do produto.
- **(a\*) plumbing copiado para a fina:** código genérico, sem conhecimento do produto, de que uma primitiva precisa:
  caminho absoluto, chave de objeto, projeção por reflexão, arquivo de autoridade, diário durável, registro de
  capturas, projeção das mensagens do `Verify`, diferença de conjuntos, classificação de diálogo para o laço vivo do
  `open_module`.
- **(a/g) guarda local:** conferência que só o Studio pode fazer, porque lê o modelo vivo ou os bytes que ele vai
  fundir, mas que reproduz parte de uma regra do kernel. Fica na fina e está listada na §0.
- **(b) vai para o servidor:** decisão ou conhecimento do kernel que pode ser calculado sobre uma captura (OML) ou sobre
  a resposta crua de uma primitiva.
- **(c) cai no hospedado:** existe só para o dono.

### 1.2 `kernel/src/Anvil.Bridge`, arquivo por arquivo

Levantado por grep do namespace `Anvil.Core` e de cada tipo do Anvil.Core nos 23 arquivos do projeto.

| Arquivo | O que usa do Anvil.Core | Decisão |
|---|---|---|
| `Anvil.Bridge.csproj` | `ProjectReference ..\Anvil.Core` (linha 42): leva `Anvil.Core.dll`, `Anvil.CSharp.dll`, `Esprima.dll` | (c) a fina tem csproj próprio, sem referência ao kernel; o csproj completo não muda (tem overlay de release) |
| `Server.cs` | `Delivery.BridgeAccess.Initialize/ReadCredential/DirectoryPath/Require` (linhas 30-32 e 77) e, por dentro, `DurableJson.Lease/WriteBytes` | (a\*) a fina tem `Server.cs` próprio com os mesmos membros (`Start(int)`, `SessionId`, `StateDirectory`, `Ok/Fail/NotExecuted/Unwrap/Log`) e `Authority.cs`, cópia de `BridgeAccess`+`DurableJson`: mesma pasta (`ANVIL_AUTHORITY_DIR`), mesmo `bridge.key` (64 hex), mesma ACL, comparação em tempo constante. O `Server.cs` completo não muda (overlay) |
| `Dispatch.cs` | nenhum (`ScApi.Catalog` é da própria bridge) | a fina tem `Dispatch.cs` próprio (20 verbos, `flavor`); o completo não muda (overlay) |
| `Studio.cs` | nenhum | (a) compartilhado; recebe `ServiceCenterApi(object provider)`, movido de `ExportHandler.cs` |
| `Reads.cs` | `ModelHost.Messages/Describe/ValidationDetails/Prop/Kind/FlowNodes`, `EntityIndexes.IncludeNative/TypeName`, `MessageDelta`, `MergeHandler.Snapshots` | dividido em `partial`: `ActiveModule`, `OpenModules`, `OnUi` (a) compartilhados; `Errors` (a) versão fina, sem as dicas do kernel (`VerifyHints`, `ExpressionCheck`); `Find` (b) no servidor, sobre captura; `FlowNodes` (c) sem chamador no kernel nem na fachada (só scripts Python do dono, que usam a completa) |
| `MergeHandler.cs` | `SnapshotRegistry`, `MergeJournal`, `PathArgs`, `ModelHost.Messages`, `MessageDelta`/`MessageInfo`, `ReferenceSignatureMerge.Analyze/MergeInCurrentCommand/VerifyApplied`, `SnapshotRegistry.RequireForeignIdentity` | nativo (a): `SaveToMemoryStream`, `ESpace.Load`, `MatchTree`, `CompareAndMergeCommands.CompareAndMerge/Merge`, `Command.Execute`, `Verify`, `IsValid`, `ExecuteInContext`. Segurança e plumbing (a\*): `SnapshotRegistry`, `MergeJournal`, `DurableJson`, `PathArgs`, projeção das mensagens, `MessageDelta`. Julgamento de `Analyze` sobre base e candidato (ambiguidade, assinatura inválida, identidade da referência do candidato) (b): servidor. Guarda local (a/g): o plano cobre os bytes carregados, a metade de `Analyze` que lê o modelo vivo (`ReferenceSignatureMerge.cs:83-101`) e a seleção dentro do comando nativo (raízes explícitas, par `ReferenceHash`, `MergeAction.Update`, conferência de retenção) (§3.3). A fina tem `MergeHandler.cs` próprio; o completo não muda (overlay) |
| `ExportHandler.cs` | `PathArgs`, `Json.Project` | (c) `export_modules`/`export_status` não existem na fina (o hospedado já os recusa: `hosted/o11-stage.mjs:9`); o auxiliar `ServiceCenterApi` vai para `Studio.cs` |
| `EnvironmentSessionHandler.cs` | `HeadlessSession.Borrow`, `EnvironmentOperations.Names/Execute` (que entram nos ramos não conectados de `HeadlessSession`, em `Publisher.*`, `TemplateModules.DownloadTemplateModule` e `EnvironmentData.Execute`), `ConnectedEnvironment.Wire`, registros de `Kernel/Dtos.cs` | (a) a concessão (`connect`/`close`/validação) e cada uma das 22 operações são UMA chamada sobre o login do Studio (SOAP `IServiceCenter`, REST `ServerAPIServices`/`TemplateManager`, Edit Data do provider). A fina as reimplementa como primitivas de uma chamada (`EnvironmentPrimitives.cs`, §3.6), com o mesmo fio. A orquestração (achar módulo, esperar publicação, módulo de template, refresh de referências, esquema de dados) já está no CLI. O completo não muda |
| `LoginHandler.cs` | `PathArgs` | (c) login por arquivo de credencial; o hospedado já o recusa |
| `Dialogs.cs` | `DialogPolicy` (classificação, `IsBlockingPresenterKind`, `Hint`, constantes), `ModelHost.Prop` | (a\*) compartilhado via `BridgeKit` (§2.4): o laço vivo do `open_module` e a recusa do merge precisam separar progresso de bloqueio, e isso só se decide dentro do Studio |
| `WindowsHandler.cs` | nenhum | (a) compartilhado |
| `OpenHandler.cs` | nenhum (usa `Dialogs`, `Reads.OnUi`, `SilentModeLease` e o `ReferencesManager` nativo) | (a) compartilhado sem edição |
| `PublishHandler.cs` | nenhum | (a) compartilhado sem edição |
| `PublishConfirmation.cs` | nenhum | (a) compartilhado sem edição |
| `PublishLog.cs` | nenhum | (a) compartilhado sem edição |
| `PublishLogHandler.cs` | `EntityIndexes.IncludeNative/TypeName`, `ModelHost.Kind/PathOf/Prop`, só no resolvedor de nomes citados (`Resolver`/`Index`) | leitura do painel (a) compartilhada; o resolvedor (b) fica só na completa (método `partial`); na fina devolve nulo e o elemento sai só de `ExtraInfo` |
| `SilentModeLease.cs` | nenhum | (a) compartilhado sem edição |
| `ScApiHandler.cs` | nenhum direto (`ExportHandler.ServiceCenterApi`, `Dispatch.BridgeInfo`) | (a) compartilhado; passa a chamar `Studio.ServiceCenterApi` |
| `ScOperations.cs` | `Keys.ToDb/Parse` (linhas 76 e 83), `PathArgs.Absolute` (134), `Json.Project` (515) | (a) compartilhado; o plumbing passa a vir de `BridgeKit`. A linha 407 (`table.Keys`) é a propriedade do dicionário, não `Anvil.Core.Keys` |
| `ScProtocol.cs` | nenhum | (a) cópia idêntica na fina, não link: tem overlay, e o overlay usa `Ssam.Runtime`, que a fina não pode referenciar (um link não compilaria numa árvore de release encenada); `CopiedFilesTests` prova a igualdade. Leva o texto `wrightflood` em `ScGuard.Corporate` (linha 96; o overlay de release troca por `corporateHosts` do `config.json`): §6.4 regra 4, pergunta aberta 4 |
| `ScSecrets.cs` | nenhum | (a) cópia idêntica na fina, não link: o overlay usa `Anvil.Core.McpContinuations`; `CopiedFilesTests` prova a igualdade |
| `ScVault.cs` | nenhum | (a) compartilhado sem edição: `CredReadW` no cofre do CLIENTE |
| `ScWebHandler.cs` | nenhum | (a) compartilhado sem edição |

### 1.3 Fora de `Anvil.Bridge`

| Peça | O que usa | Decisão |
|---|---|---|
| `kernel/tools/Anvil.RuntimeHook/StartupHook.cs` | nada do kernel; confere os nomes `Anvil.Bridge` e `Anvil.Core` já carregados (linhas 49-54) e chama `Anvil.Bridge.Server.Start(int)` (68) | sem mudança: a escolha da bridge é o `bridgePath` do `.json` do gancho. O agente aponta para a fina do pacote, o dono para a completa da compilação dele |
| `kernel/tools/Anvil.Connect/Program.cs` | nada do kernel; `describe` devolve `bridgePath` e `corePath` pelos nomes dos módulos (25-26) | sem mudança: fina carregada = `bridgePath` preenchido e `corePath` nulo |
| `kernel/tools/Anvil.StartupHook`, `kernel/tools/Anvil.Inject` | nada do kernel; procuram `Anvil.Bridge.dll` e `Anvil.Bridge.Server` | ferramentas do dono, fora do pacote; sem mudança |
| `kernel/src/Anvil.Core/Adapters.SS11/BridgeClient.cs` | é kernel (roda no servidor no hospedado) | ganha o decorador `ThinBridge` (§4) |
| relay (`hosted/o11-relay.mjs`), `hosted/agent-executor.mjs`, `hosted/o11-stage.mjs`, `agent/lib/o11-wire.mjs` | — | protocolo inalterado. `reference_plan` passa sem reescrita: o espelho e o agente só reescrevem os campos de caminho (`hosted/o11-stage.mjs:20-22`, `agent/lib/kinds.mjs:184-187`) |

**Overlays de release.** `scripts/release/overlay/` traz patches para `Anvil.Bridge.csproj`, `Dispatch.cs`,
`MergeHandler.cs`, `ScProtocol.cs`, `ScSecrets.cs`, `Server.cs`, `Anvil.RuntimeHook/StartupHook.cs` e `.csproj`,
`Anvil.Connect/Program.cs`, `Anvil.Cli/Program.cs`, `Anvil.Core/Adapters.SS11/HeadlessSession.cs`,
`ReferenceRefresher.cs`, `Delivery/BridgeAccess.cs`, `Kernel/DialogPolicy.cs`, `platforms/odc/studio/shared/Manifest.cs`,
entre outros. Editar um arquivo com overlay o torna obsoleto, e `scripts/release/stage.mjs` recusa (`stale overlay`,
`platforms/odc/tests/stage.test.mjs`). **Nenhuma faixa edita arquivo com overlay.** Por isso a fina tem o mesmo nome
de assembly (gancho e conector intactos), por isso o decorador entra em `BridgeClient.cs` e não nos cinco
`new BridgeClient(` de `Anvil.Cli/Program.cs`, e por isso a fina tem `Server.cs`, `Dispatch.cs` e `MergeHandler.cs`
próprios. O overlay de `DialogPolicy.cs` só troca os textos de `Hint`; a fina copia o dev, que é o que o teste de
paridade compara (§8.4).

### 1.4 Respostas aos pontos de atenção

- **Merge nativo × lógica do kernel.** É nativo: carregar candidato e base (`ESpace.Load`), a árvore de diferenças e
  conflitos (`MatchTree`), o merge (`CompareAndMergeCommands.CompareAndMerge` ou `Merge` dentro de `Command.Execute`,
  com Ctrl+Z), o `Verify` antes e depois e o `IsValid`. É segurança local, mantida como plumbing: a base tem de ser uma
  captura desta sessão da bridge (`SnapshotRegistry`), o candidato tem a mesma chave do módulo aberto, os sha256 batem,
  um merge por vez, o diário com o `operation_id` (`MergeJournal`, `merge_status`). É lógica do kernel e vai para o
  servidor: julgar a assinatura nova de cada produtor sobre base e candidato (`ReferenceSignatureMerge.Analyze`,
  conflitos `ambiguous-producer`, `invalid-foreign-signature`, `foreign-reference-identity`). Fica na fina, como guarda
  local (§3.3): conferir que o plano recebido cobre todo produtor cujo `ReferenceHash` difere entre os bytes que ela
  carregou, conferir no modelo vivo a identidade do produtor e da referência (a metade de `Analyze` que só o Studio
  vê), e a mecânica que só existe dentro do comando do Studio: o `ReferenceHash` é `IgnoreForDiff`, então a seleção
  precisa de raízes explícitas na árvore e de `MergeAction.Update` no par certo.
- **Refresh de referências.** `ReferenceRefresher.RefreshModule` é chamado pelo CLI
  (`kernel/src/Anvil.Cli/Program.cs:440`) sobre uma `HeadlessSession`; com o Studio conectado essa sessão é
  `HeadlessSession.ConnectStudio(new BridgeClient(...))`, que só pede `environment_session` (`download` com pasta
  temporária, `signature`, ...). `NativeDependencyReader` roda no CLI sobre os binários de assinatura
  (`ReferenceRefresher.cs:148/162`, `ProducerSignatureCapture.cs:66/80`). Nenhum dos dois roda dentro do Studio. O que
  volta ao Studio é o candidato com as referências novas, e a troca de `ReferenceHash` passa pela seleção explícita do
  merge (§3.3).
- **Dados.** `EnvironmentData.Execute` (lado Studio, `EnvironmentData.cs:30-58`) só repassa chaves e textos a
  `GetRecords`, `InsertRecords`, `UpdateRecords` e `DeleteRecords` do provider, com a recusa dos módulos `(System)` e
  `Users`: (a) primitivas `data-read`/`data-write` da fina. Esquema, `WireRecords` e `NamedRows` já são do CLI.
- **Publicação.** `publish` (1-Click Publish pelo comando do Studio) e `publish_log` (painel do Studio) são primitivas
  compartilhadas. `publish-start`/`publish-check` (`Start1CP` e `CheckPublishAsync` pela sessão,
  `Publisher.cs:218/233`) são primitivas de uma chamada da `environment_session`; a espera e a orquestração são do CLI.
- **Service Center.** `ScProtocol`, `ScSecrets`, `ScVault`, `ScWebHandler`, `ScOperations` e `ScApiHandler` usam a
  sessão do Studio e o cofre do CLIENTE e não levam lógica do kernel (listas fechadas, guarda de escrita, redação).
  Ficam do lado do cliente, compartilhados por link: uma lista fechada só. Nota: `ScGuard.Corporate`
  (`ScProtocol.cs:96`) tem o texto `wrightflood` fixo (§6.4 regra 4, pergunta aberta 4).
- **`BridgeClient` e relay.** O CLI do kernel no servidor continua falando linhas com o relay (`ANVIL_BRIDGE_PORT`), que
  encaminha `o11.bridge` ao agente, que fala com a fina com a chave local (FASE2 §4.6). Nada muda no fio; muda só o que
  o `BridgeClient` pede quando `ANVIL_BRIDGE_FLAVOR=thin` (§4).

## 2. A bridge fina

### 2.1 Assembly e projeto

`kernel/src/Anvil.Bridge.Thin/Anvil.Bridge.Thin.csproj`:

- `TargetFramework` `net8.0`, `AssemblyName` `Anvil.Bridge`, `RootNamespace` `Anvil.Bridge`, `Nullable` e
  `ImplicitUsings` ligados, `RollForward` `Major`, `SSDir` com o mesmo padrão da completa.
- 20 `Reference`, todas `Private=false`: as 23 de `Anvil.Bridge.csproj:17-39` menos `ServiceStudio.Commands`,
  `ServiceStudio.Merge` e `ServiceStudio.Undo`, que não existem no Service Studio 11.55.91.65258 (conferido em
  `C:\Program Files\OutSystems\Service Studio 11\Service Studio`; os namespaces vivem em outros assemblies do Studio, e
  o overlay de release do csproj completo as tira pelo mesmo motivo: `Anvil.Bridge.csproj.patch`). Nenhum
  `ProjectReference`, nenhum `PackageReference`.
- `Compile Include` com `Link` dos 14 arquivos compartilhados (§2.2). O glob padrão cobre só a pasta do projeto.
  Nenhum arquivo linkado tem overlay de release (`CopiedFilesTests`).
- `InternalsVisibleTo` `Anvil.Bridge.Thin.Tests`.
- Guarda de compilação: um alvo depois de `ResolveAssemblyReferences` falha a compilação quando algum `@(ReferencePath)`
  tem `Filename` começando com `Anvil.` ou `SSAM.`, ou igual a `Esprima`.
- Herda `kernel/Directory.Build.targets` (compilação contra qualquer Service Studio), como os outros projetos.
- Entra em `kernel/Anvil.slnx`, com o projeto de testes `kernel/tests/Anvil.Bridge.Thin.Tests`: 14 arquivos
  compartilhados e o `BridgeKit` em paridade quebrariam calados até a hora do pacote se só o `agent-pack.ps1` a
  compilasse.

Por que o mesmo nome de assembly:

- `Anvil.RuntimeHook` procura `Anvil.Bridge` já carregado e recusa outro caminho (`StartupHook.cs:49-51`), recusa
  `Anvil.Core` sem bridge (52-54) e chama `Anvil.Bridge.Server.Start(int)` (68). Com o mesmo nome, a mesma lógica
  protege os dois casos: um Studio nunca recebe duas bridges.
- `Anvil.Connect describe` acha a bridge pelo módulo `Anvil.Bridge.dll` (`Program.cs:25`), e o agente já usa
  `bridgePath`/`corePath` para recusar um segundo attach (`agent/lib/o11-connect.mjs:87`).
- Gancho e conector têm overlay de release (§1.3). Um nome novo exigiria editá-los.
- `agent/lib/o11-connect.mjs:97` continua escrevendo `bridgePath: bin\o11\bridge\Anvil.Bridge.dll`.

Esses motivos valem para o gancho de desenvolvimento (`kernel/tools/Anvil.RuntimeHook` compilado do fonte, que é o
`Anvil.RuntimeHook.Agent.dll` do pacote). O gancho de release (`StartupHook.cs.patch`, ABI `h1`) procura
`Start(int, string, string)`, que a fina também tem, mas ainda confere a pasta da bridge contra o manifesto assinado do
release e espera `pid` e `bridgeId` no `bridge_manifest`, que a fina não dá: limite na §9.

### 2.2 Arquivos

Compartilhados por link (14), todos de `kernel/src/Anvil.Bridge/`: `Studio.cs`, `Reads.cs`, `Dialogs.cs`,
`WindowsHandler.cs`, `OpenHandler.cs`, `PublishHandler.cs`, `PublishConfirmation.cs`, `PublishLog.cs`,
`PublishLogHandler.cs`, `SilentModeLease.cs`, `ScApiHandler.cs`, `ScOperations.cs`, `ScVault.cs`, `ScWebHandler.cs`.

Cópias idênticas (2), em `kernel/src/Anvil.Bridge.Thin/`: `ScProtocol.cs` e `ScSecrets.cs`. Os dois têm overlay de
release que passa a usar `Ssam.Runtime` e `Anvil.Core`; linkados, a fina não compilaria numa árvore encenada por
`scripts/release/stage.mjs`. `CopiedFilesTests` prova que cada cópia é igual ao arquivo da completa e recusa link para
arquivo com overlay. Quem muda um dos dois na completa copia de novo para a fina.

Próprios da fina (em `kernel/src/Anvil.Bridge.Thin/`, namespace `Anvil.Bridge`):

| Arquivo | Conteúdo |
|---|---|
| `Server.cs` | igual ao completo, com `Authority` no lugar de `Anvil.Core.Delivery.BridgeAccess`; mais `Start(int, string, string)`, a entrada do gancho de release (pasta do log e autoridade por parâmetro; `Start(int)` = `Start(porta, null, null)`) |
| `Dispatch.cs` | tabela dos verbos (§3.2: 20, e 21 desde a nona entrega, §14); `BridgeInfo()` com `flavor:"thin"`; verbo desconhecido → `Server.NotExecuted("Unknown method: <m>")` |
| `Authority.cs` | cópia de `BridgeAccess` (`DirectoryPath`, `ResolveDirectory`, `KeyPath`, `Initialize`, `ReadCredential`, `Matches`, `Require`, com as sobrecargas que recebem a pasta da autoridade, como no overlay de release) e de `DurableJson` (`Lease`, `Hash`, `Read`, `Write`, `WriteBytes`) |
| `BridgeKit.cs` | as cópias de plumbing da §2.4 |
| `ReadsThin.cs` | `partial class Reads`: `Errors` da fina (§3.4) |
| `PublishLogResolver.cs` | implementação `partial` do resolvedor que devolve `null` |
| `MergeHandler.cs` | `Snapshot`, `Merge`, `Status` da fina (§3.3) |
| `MergeSupport.cs` | cópias de `SnapshotRegistry`, `RegisteredSnapshot`, `MergeJournal`, `MessageInfo`, `MessageDelta` e `NativeMessages.Messages` (= `ModelHost.Messages` com `PathOf`, `Kind`, `Prop`) |
| `ReferenceSelections.cs` | o registro `ReferencePlan` (mesmos nomes do JSON) e a guarda do merge de assinaturas: `RequireComplete`, `Effective`, `MergeInCurrentCommand`, `VerifyRetained` (§3.3) |
| `EnvironmentSessionHandler.cs` | concessão igual à completa (`Session`, `Connect`, `Validate`, `close`, `Gate`, expiração de 1 h) chamando `EnvironmentPrimitives.Execute` |
| `EnvironmentPrimitives.cs` | as 22 operações de uma chamada (§3.6) |
| `EnvironmentWire.cs` | registros do fio com os mesmos nomes e ordem de campos dos do kernel (§3.6) |

### 2.3 Edições mecânicas na bridge completa

Todas em arquivos sem overlay. O comportamento da completa fica idêntico: o plumbing dela delega ao Anvil.Core, e o
resto é código movido de arquivo.

| Arquivo | Edição |
|---|---|
| `BridgeKit.cs` (novo) | a versão completa de `BridgeKit` (§2.4): cada membro delega ao Anvil.Core (`Keys`, `PathArgs`, `Json`, `ModelHost.Prop`, `DialogPolicy`) |
| `ScOperations.cs` | sai `using Anvil.Core;`; `Keys.ToDb` → `BridgeKit.DbKey`, `Keys.Parse` → `BridgeKit.ParseKey`, `PathArgs.Absolute` → `BridgeKit.Absolute`, `Json.Project` → `BridgeKit.Project` |
| `Studio.cs` | recebe `internal static IServiceCenter? ServiceCenterApi(object provider)`, corpo movido sem mudança de `ExportHandler.cs:126-139` (usa o `All` de `Studio`, de mesmo valor) |
| `ExportHandler.cs` | `ServiceCenterApi(provider)` vira `=> Studio.ServiceCenterApi(provider)` (o `EnvironmentSessionHandler.cs` completo continua chamando por ali) |
| `ScApiHandler.cs` | `ExportHandler.ServiceCenterApi` → `Studio.ServiceCenterApi` (linha 167) |
| `Dialogs.cs` | sai `using Anvil.Core;`; `DialogPolicy.*` → `BridgeKit.*`, `ModelHost.Prop` → `BridgeKit.InterfaceProp` |
| `Reads.cs` | vira `internal static partial class Reads` com `ActiveModule`, `OpenModules` e `OnUi`; sai `using Anvil.Core;` |
| `ReadsKernel.cs` (novo) | `partial class Reads` com `Errors`, `Find` e `FlowNodes`, movidos de `Reads.cs` sem mudança |
| `PublishLogHandler.cs` | vira `partial`; `Read` chama `private static partial Func<string, JsonObject?>? ResolverFor(ESpace e)`; `Resolver` e `Index` saem para o arquivo abaixo; sai `using Anvil.Core;` |
| `PublishLogResolver.cs` (novo) | implementação completa de `ResolverFor` = `Resolver` e `Index` movidos sem mudança |
| `kernel/tests/Anvil.Tests/Anvil.Tests.csproj` | mais uma linha: `<Compile Include="../../src/Anvil.Bridge/BridgeKit.cs" Link="Bridge/BridgeKit.cs" />` (o projeto já compila `ScOperations.cs`) |
| `kernel/Anvil.slnx` | duas linhas: `src/Anvil.Bridge.Thin/Anvil.Bridge.Thin.csproj` em `/src/` e `tests/Anvil.Bridge.Thin.Tests/Anvil.Bridge.Thin.Tests.csproj` em `/tests/` |

`Dispatch.cs`, `MergeHandler.cs`, `Server.cs`, `EnvironmentSessionHandler.cs`, `LoginHandler.cs`, `ScProtocol.cs`,
`ScSecrets.cs` e `Anvil.Bridge.csproj` da completa não mudam.

### 2.4 `BridgeKit`

Duas implementações com a mesma superfície, ambas `internal static class BridgeKit` no namespace `Anvil.Bridge`: a
completa (`kernel/src/Anvil.Bridge/BridgeKit.cs`) delega; a fina (`kernel/src/Anvil.Bridge.Thin/BridgeKit.cs`) copia o
corpo, provada igual por teste de paridade (§8.4).

```csharp
internal static class BridgeKit
{
    public static ObjectKey ParseKey(string key);              // Anvil.Core.Keys.Parse
    public static string DbKey(string key);                    // Anvil.Core.Keys.ToDb
    public static string StudioKey(string key);                // Anvil.Core.Keys.ToStudio (data-read/write na fina)
    public static string Absolute(string verb, string param, string? value);  // Anvil.Core.PathArgs.Absolute
    public static JsonNode? Project(object? value);            // Anvil.Core.Json.Project
    public static object? InterfaceProp(object o, string name);  // Anvil.Core.ModelHost.Prop
    public const string Progress = "Progress", Modal = "Modal", WebDialog = "WebDialog";  // DialogPolicy
    public static bool IsBlockingPresenterKind(string kind);   // DialogPolicy.IsBlockingPresenterKind
    public static string ClassifyPresenter(IEnumerable<string> interfaceNames, string typeName);  // DialogPolicy
    public static string ClassifyWindow(string? title, IEnumerable<string> texts);                // DialogPolicy
    public static string DialogHint(string kind);              // DialogPolicy.Hint
}
```

## 3. Contrato de fio

### 3.1 A linha

Igual à da completa (`Server.cs`): TCP em `127.0.0.1:<porta>`, uma conexão por cliente, pedidos em série; pedido
`{"method": "...", "params": {...}, "authorization": "<chave>"}`; resposta `{"success": bool, "data": ..., "error":
"...", "executed"?: false}`. `ping` e `bridge_manifest` respondem sem chave; o resto exige a chave de
`<autoridade>\bridge.key` (no agente, `private\authority\bridge.key`, FASE2 §4.9). Falha antes de chegar ao verbo →
`executed:false`. O relay, o `AgentExecutor`, o espelho (FASE2 §4.6) e `agent/lib/o11-wire.mjs` não mudam.

### 3.2 Verbos

| Verbo | Na fina | Diferença da completa |
|---|---|---|
| `ping` | `{pid, bridge:"anvil", flavor:"thin", version, uiThread}` | + `flavor` |
| `bridge_manifest` | `{bridge:"anvil", flavor:"thin", protocolVersion:2, authentication:true, verbs:[os 21], capabilities, serviceCenter}` | + `flavor`; `capabilities` = as da completa, na mesma ordem (com `"merge_from_oml:first_pass"`, §12, e as da nona entrega, §14) + `"thin"` + `"merge:reference-plan"` |
| `get_active_module` | igual (arquivo compartilhado) | — |
| `list_open_modules` | igual | — |
| `get_errors` | §3.4 | sem as dicas do kernel; + `kernelHints:false` |
| `open_module`, `close_module` | iguais | — |
| `windows`, `close_dialog`, `ui_alive` | iguais | — |
| `publish` | igual | — |
| `publish_log` | igual; `element` só de `ExtraInfo` (`Name;Key`) | sem resolver nome citado para elemento do modelo |
| `snapshot_module {path, module_key?, environment?}` | igual; `baseline` com as mensagens projetadas (§3.4) | — |
| `merge_from_oml` | §3.3 | + `reference_plan`, obrigatório com `base_path` |
| `merge_status {operation_id, module_key?}` | igual | — |
| `environment_session` | §3.6 | mesmo fio |
| `sc_api`, `sc_web`, `sc_session`, `studio_login` | iguais (arquivos compartilhados) | — |
| `refresh_references {module_key, environment?, producers?, producer_keys?, timeout?}` | igual (arquivo compartilhado, desde a nona entrega, §14) | — |
| `login`, `export_modules`, `export_status`, `find_element`, `get_flow_nodes` | `{success:false, executed:false, error:"Unknown method: <m>"}` | removidos |

A lista dos 21, na ordem de `verbs`: `ping`, `bridge_manifest`, `get_active_module`, `list_open_modules`,
`get_errors`, `open_module`, `close_module`, `publish`, `windows`, `ui_alive`, `close_dialog`, `snapshot_module`,
`merge_from_oml`, `merge_status`, `environment_session`, `sc_api`, `sc_web`, `studio_login`, `sc_session`,
`publish_log`, `refresh_references` (este desde a nona entrega, §14). A lista só cresce com um teste
(`DispatchTests`, `agent/tests/kinds.test.mjs`) e uma linha neste documento.

### 3.3 `merge_from_oml` e `reference_plan`

Parâmetros: os da completa (`foreign_path` absoluto e obrigatório, `base_path` absoluto, `mode`
`preview|auto|dialog` com padrão `auto`, `match_by_structure`, `dump_chars`, `operation_id`, `base_sha256`,
`foreign_sha256`, `module_key`, `environment`, e desde a oitava entrega `first_pass_path` e `first_pass_sha256`, §12) e o
novo `reference_plan`, exatamente o
`JsonSerializer.SerializeToNode(ReferenceSignatureMergePlan)` do kernel com as opções padrão:

```json
{ "Changes": [ { "ProducerKey": "<chave>", "LocalReferenceKey": "<chave>", "BaseReferenceKey": "<chave>",
                 "ForeignReferenceKey": "<chave>", "Kind": "eSpace", "BaseHash": "<guid>", "LocalHash": "<guid>",
                 "ForeignHash": "<guid>" } ],
  "Conflicts": [ { "ProducerKey": "<chave>", "Code": "<código>", "Message": "<texto>" } ],
  "HasChanges": true, "HasConflicts": false }
```

A fina lê para o registro próprio `ReferencePlan` (mesmos nomes). **Com `base_path`, `reference_plan` é
obrigatório.** Sem `base_path` a fina já recusa pelo `SnapshotRegistry` (`RequireBase` sem bytes lança), como a
completa; então todo merge que chega a rodar tem plano. Plano ausente ou ilegível (outro nome de campo, `Guid`
inválido, `Changes`/`Conflicts` que não são listas) → `executed:false`, "merge_from_oml: the thin bridge needs the
reference_plan computed by the server; update the server", antes do diário. Motivo: `ReferenceHash` é `IgnoreForDiff`;
com plano vazio ou incompleto o `CompareAndMerge` nativo descartaria toda troca de assinatura de produtor e ainda
responderia `merged:true` (`writeState` `applied`). Casos reais: um servidor da fase 2 (`acba66d8`, o da porta 7300,
sem `ThinBridge`), um chamador direto, um defeito do `ThinBridge`. O plano não leva sha256 próprio: a guarda do passo 2
o confere contra os bytes carregados, e `base_sha256`/`foreign_sha256` já prendem esses bytes.

O `Merge` da fina é o da completa (`MergeHandler.cs:43-238`) com `signaturePlan` = o plano efetivo do passo 3:

1. As mesmas conferências antes de tudo, todas `executed:false`: caminhos absolutos e existentes, `mode` e, com
   `base_path`, `reference_plan` presente e legível (estas três junto, antes de tocar a UI, como as linhas 50-54 da
   completa); depois diálogo ou `Match` pendente, `allow_foreign_base` removido, base registrada nesta sessão
   (`SnapshotRegistry.RequireBase`), `base_sha256`/`foreign_sha256`, um merge por vez, diário por `operation_id`
   (`operation_id` repetido devolve o recibo gravado).
2. Carrega candidato e base, confere a chave do candidato (`RequireForeignIdentity`) e roda a **guarda de cobertura**
   `ReferenceSelections.RequireComplete(base, foreign, plano)`. Agrupando as referências por `ReferenceKey` como
   `Analyze`, para cada produtor do candidato que também está na base:
   - mais de uma referência dele na base ou no candidato → o plano tem um conflito desse `ProducerKey`;
   - uma de cada lado e `ReferenceHash` diferente → o plano tem um conflito desse `ProducerKey` ou exatamente uma
     mudança dele com `BaseReferenceKey`/`ForeignReferenceKey` = as chaves das duas referências, `Kind` = o
     `ReferenceKind` do candidato, `BaseHash`/`ForeignHash` = os dois hashes;
   - e nenhuma mudança do plano fica sem um par assim.

   Falha lança antes do nativo: `executed:false` ("reference_plan does not cover the loaded base/candidate; recompute
   it on the server"), com o mesmo registro `merged:false` no diário que a completa grava para uma recusa antes do
   nativo (`MergeHandler.cs:105-111`). A guarda não julga a validade da assinatura do candidato: isso é do servidor.
3. **Plano efetivo** `ReferenceSelections.Effective(local, plano)`, no ponto em que a completa chama `Analyze`
   (`MergeHandler.cs:154`): a metade de `Analyze` que lê o modelo vivo (`ReferenceSignatureMerge.cs:83-101`), para cada
   mudança do plano, com o `ProducerKey` lido de `Reference.ReferenceKey`:
   - a referência viva com `Key` = `BaseReferenceKey`, se existe, tem o mesmo `ProducerKey`; senão conflito
     `producer-identity-changed`;
   - existe exatamente uma referência viva com esse `ProducerKey`; senão `local-producer-missing-or-ambiguous`;
   - essa referência tem `Key` = `BaseReferenceKey` e `ReferenceKind` = `Kind`; senão
     `local-reference-identity-changed`;
   - o `ReferenceHash` vivo é `BaseHash` ou `ForeignHash`; senão `concurrent-signature`;
   - vivo = `ForeignHash`: já aplicada, sai das mudanças; vivo = `BaseHash`: fica, com `LocalReferenceKey` = chave viva
     e `LocalHash` = hash vivo.

   Os conflitos levam os mesmos códigos e textos de `Analyze` e vêm depois dos conflitos do plano. Com a guarda do
   passo 2, o plano efetivo é o `Analyze(vivo, candidato, base)` da completa: as mesmas mudanças (ordenadas por
   `ProducerKey`) e o mesmo conjunto de conflitos; só a ordem dos conflitos pode diferir (`referenceSignatures` é só
   exibição: nada no kernel nem na fachada o lê).
4. `hasNoDifferences = nativo && !efetivo.HasChanges && !efetivo.HasConflicts`;
   `hasConflicts = tree.HasConflicts || efetivo.HasConflicts`;
   `unsupportedSignatureDialog = mode == "dialog" && efetivo.HasChanges`. Mesma tabela de decisão e mesmos `reason` da
   completa (`MergeHandler.cs:174-184`). Por isso: uma referência que o usuário mudou no Studio depois da captura para
   um terceiro hash ou para outro produtor → `Server.Ok` `merged:false` "producer signature changed concurrently:
   review referenceSignatures before retrying", como na completa (`writeState` `not-applied`, a tarefa para para
   revisão, `Delivery.cs:131`); uma referência que ele já levou ao hash do candidato, sem outra diferença → "no
   differences" (`writeState` `unchanged`), como na completa; `mode:"dialog"` só é recusado quando ainda há o que
   selecionar.
5. Sem `efetivo.HasChanges`: `CompareAndMergeCommands.CompareAndMerge` nativo, como hoje.
6. Com `efetivo.HasChanges`: dentro de `Command.Execute(contexto, "Anvil: merge module and producer signatures", ...)`,
   `ReferenceSelections.MergeInCurrentCommand(local, foreign, base, plano, tree => { nativo começou;
   CompareAndMergeCommands.Merge(aggregator, tree); }, matchByStructure)`; depois, na thread de UI,
   `ReferenceSelections.VerifyRetained(local, plano)`.
7. Mensagens antes e depois por `NativeMessages.Messages` e delta por `MessageDelta`; resposta com os campos da completa:
   `mode, local, foreign, base, hasNoDifferences, hasConflicts, nativeHasNoDifferences, referenceSignatures` (= o plano
   efetivo), `dumpPath, dumpChars, dumpHead, timings, merged, reason?, result?, referenceSignaturesSelected?,
   nativeMergeCount?, new, fixed, preexisting, newErrors, localIsValidAfter, hint?, totalMs, operationId`.

`ReferenceSelections.MergeInCurrentCommand(local, foreign, basis, plan, mergeTree, matchByStructure)` é
`ReferenceSignatureMerge.MergeInCurrentCommand` (`ReferenceSignatureMerge.cs:113-144`, `173-234`) com o `ValidatePlan`
(`236-256`, que roda `Analyze` de novo no modelo vivo) trocado por `Effective`:

1. `current = Effective(local, plan)`; com conflito (do plano ou vivo), lança com o texto de `RequireNoConflicts`
   (`ReferenceSignatureMerge.cs:259-263`: produtor, `[código]` e mensagem). O `ValidatePlan` da completa lança no mesmo
   caso.
2. Árvore estrutural `new MatchTree(local, foreign, basis, matchByStructure, true)`; com conflito, lança.
3. `ValidatePairs` sobre `current.Changes`, ANTES de qualquer mutação, como `ReferenceSignatureMerge.cs:206-230`:
   referência local por `ProducerKey` E `LocalReferenceKey` (`Single`), a do candidato por `ProducerKey` e
   `ForeignReferenceKey`, a da base por `BaseReferenceKey`; o `Match` da referência local é desta árvore e liga as
   três; o par `Reference.ReferenceHashPropertyDescriptor` tem `BaseValue == BaseHash`, `LocalValue == LocalHash` e
   `ForeignValue == ForeignHash`; `MergeAction` `None` ou `Update`. Qualquer divergência lança antes de `mergeTree`, e a
   resposta é `executed:false` (o nativo não começou).
4. Se a árvore tem diferenças: `mergeTree(tree)` e exige `!tree.CanMerge`.
5. `current = Effective(local, plan)` de novo, sem conflito. Com mudanças pendentes: árvore só de referências com
   raízes explícitas (`SetESpaces` + `AddRoot` das três referências), `ValidatePairs` com alcançabilidade,
   `MergeAction.Update` em cada par, `mergeTree(tree)`, exige `!tree.CanMerge`, `VerifyRetained`.
6. `VerifyRetained(local, plan)`: `Effective(local, plan)` sem conflitos e sem mudanças; isto é, cada referência do
   plano recebido continua do mesmo produtor, única, com a mesma chave e o mesmo tipo, e com o `ForeignHash`. É o
   `VerifyApplied` da completa; roda de novo depois que `Command.Execute` volta, porque a limpeza do comando pode
   desfazer.
7. Devolve `(selecionadas, merges nativos)`.

O que ainda difere da completa, e só isto:

- plano ausente, ilegível ou que não cobre os bytes carregados → `executed:false` (a completa não tem esse caso);
- o julgamento da assinatura do candidato (`invalid-foreign-signature` com `IObjectSignature.IsValid`,
  `ambiguous-producer`, `foreign-reference-identity`) é feito pelo runtime do Studio do SERVIDOR, sobre os mesmos
  bytes; a paridade com o Studio do cliente é item da prova ao vivo (§8.8);
- a ordem dos conflitos em `referenceSignatures`.

Uma mudança concorrente no Studio depois da captura NÃO muda de comportamento: antes do comando é o `merged:false` da
completa (passo 4); dentro do comando, antes de qualquer mutação, é o `executed:false` da completa (o `ValidatePlan`
dela também lança antes do nativo, e `MergeHandler.cs:105-111` responde `NotExecuted`).

### 3.4 `get_errors` da fina e as mensagens

Parâmetros: `{max? (60), since?, module_key?, environment?}`. Resposta:

```
{ rawMessages: [MessageInfo], isValid, errors, warnings, total, byType: {<type>: n}, messages: [string], verifyMs,
  kernelHints: false,
  // com since:
  snapshot_id, new: [MessageInfo], fixed: [MessageInfo], preexisting: [MessageInfo], newErrors }
MessageInfo = { id, type, key, path, detail }
```

- `NativeMessages.Messages(espace)` é cópia de `ModelHost.Messages` (`ModelHost.cs:218-233`): uma linha por mensagem
  de `espace.Verify()`, `key` = JSON de `[Id, chave do objeto, PropertyNames, MessageParameters]`, `path` por `PathOf`
  (até 6 níveis), `detail` = mensagem + `" | "` + detalhe.
- O `MessageInfo` da fina serializa igual ao do kernel (`Kernel/Messages.cs:6-15`): `JsonPropertyName` `id`, `type`,
  `key`, `path`, `detail`, nessa ordem, e `IsError` com `JsonIgnore`; o `MessageDelta` usa `new`, `fixed`,
  `preexisting`. O servidor desserializa `baseline` e `rawMessages` no `MessageInfo` do kernel
  (`Delivery.cs:187-199`) e `MessageExpectations` depende dessa forma, e a identidade de uma mensagem é o texto exato
  de `key`.
- `isValid` = `espace.IsValid`; `byType` conta por `type`; `errors`/`warnings` somam os tipos com `Error`/`Warning`.
- `messages` = `ValidationDetails` sem as dicas: os erros todos, os avisos até `max`, e a linha
  `"... N more warnings not shown (of M)"` quando sobram. `VerifyHints.Inline`, `ExpressionCheck.Hints` e
  `ExpressionCheck.CurrentHints` ficam no kernel (servidor).
- `snapshot_module` grava em `baseline` as mesmas `MessageInfo`; o `since` usa o `SnapshotRegistry` da fina.

### 3.5 `publish_log` da fina

Mesmo verbo, mesmo arquivo `PublishLogHandler.cs` e mesma `PublishLog.Project`, com `resolve = null`: um `Error` ou
`Warning` só ganha `element` quando a linha traz `ExtraInfo` no formato `Name;Key`; senão leva `extraInfo` como hoje. A
fachada já trata `element` como opcional (`o11-studio.mjs` `elementOf`, `publishFixContinuation`).

### 3.6 `environment_session` da fina

O fio é o de hoje (`ConnectedEnvironment.cs`):

- `{operation:"connect", host?, module?, readOnly?}` → `{lease, host, username, ideVersion, serverVersion,
  operations:[as 22]}`. Mesma escolha do provider (host pedido, módulo, ativo, único), no máximo 128 concessões,
  expiração de 1 h.
- `{operation:"close", lease}` → `{closed:true}`.
- `{operation, lease, arguments}` → `{value}`, com `value` serializado com `IncludeFields = true`
  (`ConnectedEnvironment.Wire`). Antes de cada chamada a fina revalida na UI que provider, login, host e usuário são os
  da concessão; o segredo (`GetSecretForWebServiceRequest`) é tirado na hora e nunca sai do processo.
- Concessão `readOnly` recusa as escritas (`application-save`, `module-associate`, `application-delete`,
  `module-delete`, `publish-start`, `data-write`), como `ConnectedEnvironment.WriteOperations` e o `RequireWrite` do
  kernel.

| Operação | Argumentos | Uma chamada no Studio | `value` |
|---|---|---|---|
| `applications` | — | `IServiceCenter.ListApplications(user, secret, false)` | `ApplicationSummary[]` |
| `modules` | — | `ListEspaces` | `ModuleSummary[]` |
| `application-icon` | `nameOrKey` | `ListApplications(..., true)` | `byte[]?` |
| `catalogs` | — | `ListCatalogs` | `CatalogSummary[]` |
| `referenceable` | — | `ListReferenceable` | `ReferenceableSummary[]` |
| `extensions` | — | `ListExtensions` | `ModuleSummary[]` |
| `extension-download` | `extensionKey`, `versionId` (> 0) | `DownloadExtension` (chave em forma DB) | `byte[]` |
| `versions` | `moduleKey` | `ListVersions` | `int[]`, decrescente |
| `templates` | — | REST `https://<host>/TemplateManager/rest/TemplateServices/Apps_ListTemplates`, Basic `user:secret` | `TemplateSummary[]` |
| `template-module` | `templateKey` | `GetESpaceForTemplate` | `(byte[], string)` |
| `template-download` | `templateKey` | REST `.../Apps_GetTemplateESpace?ESpace_Key=<DB>` | `(byte[], string)` |
| `signature` | `producerKey`, `kind` | REST `ServerAPIServices.GetReferenceDetails(login, <DB>, ct)`; sem binário, SOAP `GetReferenceDetails` | `ReferenceInfo?` |
| `template-user-provider` | `templateKey` | `GetTemplateInfo` | `(string, string)?` |
| `download` | `module` (`ModuleSummary`), `outputDirectory?`, `versionId?` | `Download` (versão 0 → a primeira de `ListVersions`), grava `<pasta>\<nome>.oml` | `DownloadResult` |
| `application-save` | `name`, `kind`, `description?`, `existingKey?`, `templateKey?`, `primaryColor?`, `icon?` | `CreateOrUpdateApplication` | `(string, bool, string?)` |
| `module-associate` | `appKey`, `moduleKey` | `AddModuleToApplication` | `(bool, string?)` |
| `application-delete` | `appKey`, `simulate` | `DeleteApplication` | `DeleteOutcome` |
| `module-delete` | `moduleKey` | `DeleteModule` | `(bool, string?)` |
| `publish-start` | `oml`, `appKey`, `catalogId?`, `commitMessage` | `Start1CP` com as `PublishOptions` de `Publisher.StartPublish` | `PublishOutcome` |
| `publish-check` | `previous` (`PublishOutcome`) | `CheckPublishAsync` | `PublishOutcome` |
| `data-read` | `moduleKey`, `entityKey`, `tenantId?`, `ids?`, `offset`, `includeBinary` | provider `GetRecords` | `Row[]` |
| `data-write` | `moduleKey`, `entityKey`, `tenantId?`, `operation` (`insert`/`update`/`delete`), `records?`, `ids?` | provider `InsertRecords`/`UpdateRecords`/`DeleteRecords` | `Report[]` |

O corpo de cada linha é o ramo não conectado de hoje (`HeadlessSession.cs` 137-392, `Publisher.cs` 38-88 e 201-243,
`TemplateModules.cs:24-41`, `EnvironmentData.cs:30-91`), copiado. `EnvironmentWire.cs` copia os registros com os mesmos
nomes e ordem: `ApplicationSummary`, `ModuleSummary`, `CatalogSummary`, `ReferenceableSummary`, `TemplateSummary`,
`DownloadResult` (`Kernel/Dtos.cs`), `PublishMessage`, `PublishOutcome` (`Kernel/Adapter/PublishOutcome.cs`),
`DeleteOutcome` (`Publisher.cs:68`), `Row`, `Cell`, `Report` (`EnvironmentData.cs:24-26`). `ReferenceInfo`, `ApplicationInfo`,
`ModuleInfo`, `PublishOptions` e `ModuleVersion` são tipos do Studio, os mesmos dos dois lados.

## 4. O que vai para o servidor

### 4.1 `ThinBridge` no `BridgeClient` do kernel

`kernel/src/Anvil.Core/Adapters.SS11/BridgeClient.cs` (sem overlay) passa a ser:

```csharp
public sealed class BridgeClient(int port, int timeoutSeconds = 120) : IBridgeClient
{
    private ThinBridge? thin;
    public JsonObject Call(string method, JsonObject? parameters = null)
        => ThinBridge.Enabled ? (thin ??= new ThinBridge(Send)).Call(method, parameters) : Send(method, parameters);
    // Send = the current body of Call; its socket timeout is ThinBridge.EffectiveTimeout(timeoutSeconds).
}
```

`kernel/src/Anvil.Core/Adapters.SS11/ThinBridge.cs` (novo, `internal sealed class ThinBridge`; a pasta
`Adapters.SS11` não entra no `Anvil.Core.Odc`, que compila só `Kernel/`, `Delivery/`, `Hosting/` e `Properties/`):

```csharp
internal sealed class ThinBridge(Func<string, JsonObject?, JsonObject> send)
{
    public static bool Enabled { get; }            // ANVIL_BRIDGE_FLAVOR == "thin", lido a cada chamada
    public static int EffectiveTimeout(int requested);  // max(requested, ANVIL_BRIDGE_TIMEOUT_SECONDS) quando a variável existe
    public JsonObject Call(string method, JsonObject? parameters);
}
```

Não muda nenhum chamador: `Delivery.Run`, `DeliveryTask.CloseKnownFailure`, `HeadlessSession.ConnectStudio`,
`StudioProducerAuthority.ForBridge` e os cinco `new BridgeClient(` de `Anvil.Cli/Program.cs` (271, 456, 731, 771,
778) continuam iguais.

| Verbo pedido pelo kernel | `ThinBridge` |
|---|---|
| `merge_from_oml` com `base_path` | §4.2, depois repassa com `reference_plan` (um `reference_plan` que o chamador tenha posto é substituído) |
| `merge_from_oml` sem `base_path` | repassa sem plano (a fina recusa pelo `SnapshotRegistry`, como a completa) |
| `find_element {name, max?, module_key?, environment?}` | §4.3; resposta `{query, count, results:[{name, type, key, parent}]}` igual à de `Reads.Find` |
| `login`, `export_modules`, `export_status`, `get_flow_nodes` | `BridgeCallException(executed:false)`: "not available with the thin bridge (hosted)"; nada é enviado |
| todos os outros | repasse sem mudança |

**Falha antes de enviar é `executed:false`.** Toda exceção do `ThinBridge` antes do `send` (ler os arquivos,
`ModelHost`, `Analyze`, serializar o plano; em `find_element`, ler e carregar a captura) sai como
`BridgeCallException(<verbo>: <mensagem>; nothing was sent to the bridge, executed: false)`. Motivo: a entrega grava
`writeState:"intent"` antes de chamar `merge_from_oml` (`Delivery.cs:170-176`); uma exceção genérica viraria
`unknown` (`Delivery.cs:300`), a retomada pediria `merge_status` de um `operation_id` que a fina nunca viu (estado
`unknown`, `MergeJournal.cs:17`) e falharia para sempre em "Merge outcome remains unknown" (`Delivery.cs:126-127`),
embora nada tenha chegado ao Studio. Com `executed:false` o estado fica `not-sent` e a retomada tira captura nova.
Uma exceção do próprio `send` passa como está (o `BridgeClient` já a classifica).

### 4.2 Plano de assinaturas

Com `base_path` e `foreign_path` (arquivos do servidor; o espelho já os leva ao agente, FASE2 §4.6):
`new ModelHost(<pasta temporária>)`, carrega base e candidato, `plan = ReferenceSignatureMerge.Analyze(local: base,
foreign: candidato, basis: base)`, `parameters["reference_plan"] = JsonSerializer.SerializeToNode(plan)`, libera os dois
modelos (`ModelHost.Release`) e repassa. O processo do CLI que entrega já carregou o runtime do Studio para aplicar o
job. A base é a captura que a própria entrega acabou de tirar pela fina (`Delivery.cs:135`), então "local = base" é o
estado do módulo no instante da captura: com isso o plano traz o julgamento de base e candidato e uma mudança para
cada produtor que passa nele; a fina confere a cobertura sobre os bytes e o estado vivo nos passos 2 e 3 da §3.3.

### 4.3 `find_element` sobre captura

- Primeira chamada de uma sequência: `send("snapshot_module", {path: <TEMP>\thin-bridge\<guid>.oml, module_key?,
  environment?})` com os alvos recebidos; lê os bytes, apaga a cópia do servidor e carrega com `ModelHost`.
- Resposta: o corpo de `Reads.Find` (`EntityIndexes.IncludeNative`, `ModelHost.Prop/Kind`, `EntityIndexes.TypeName`),
  copiado para `ThinBridge.cs` como função pura sobre o `ESpace` carregado.
- A captura carregada vale enquanto as chamadas seguidas forem `find_element` com o mesmo `module_key` e
  `environment`; qualquer outro verbo a descarta. As verificações de `Delivery.cs:208-217` tiram uma captura só.
- O fim de cada entrega também a descarta (`Delivery.Run` chama `IBridgeClient.ReleaseCapture` no `finally`): num worker
  residente o módulo sai dos estáticos do Studio (`ModelHost.Release`) como sairia no fim de um processo frio.
- `get_flow_nodes` não é emulado: nenhum chamador no kernel nem na fachada (`Delivery.cs:212` só usa `find_element`;
  `get_flow_nodes` aparece só na bridge e em scripts Python do dono, que usam a completa). Recusa `executed:false`.
- No hospedado `TEMP` é `<ws>/o11/tmp` (FASE2 §4.7), dentro do prefixo gravável do espelho; a cópia do agente fica em
  `agent:o11/tmp/` (§9).

### 4.4 Tempo

`hostedSpawnEnv('o11')` põe `ANVIL_BRIDGE_TIMEOUT_SECONDS=600`: o tempo de espera do `BridgeClient` (120 s por padrão,
330 s nos verbos de ambiente) passa a ser pelo menos 600 s no hospedado, porque o espelho de arquivos pelo relay conta
dentro dele (FASE2 §4.6, §11). No local a variável não existe e nada muda.

### 4.5 Fachada

- `platforms/odc/facade/executor.mjs` `hostedSpawnEnv('o11')` acrescenta `ANVIL_BRIDGE_FLAVOR=thin` e
  `ANVIL_BRIDGE_TIMEOUT_SECONDS=600`. A faixa ODC não recebe nenhuma das duas.
- As chamadas diretas da fachada à bridge (`o11-publish.mjs:153/163/183/188`, `o11-studio.mjs` `status`, `wait`,
  `errors`, `publish-log`, `windows`, `dismiss-dialog`, `login`, `snapshot`, `open-module`) vão à fina pelo
  `AgentExecutor`, sem mudança. Nenhuma chamada direta usa `find_element`, `get_flow_nodes`, `login` ou `export_*`. O
  cliente hospedado vê `get_errors` sem as dicas do kernel e o log de publicação sem a resolução de nome para elemento.

### 4.6 O que já estava no servidor

Aplicação do job e construção do candidato (`Delivery.Run` → `apply`), provas de requisito e de dados
(`InspectSpecification`, `inspectData`), avaliação do contrato de mensagens (`MessageExpectations.Evaluate`), captura e
atestação de produtores (`ProducerSignatureCapture`), refresh de referências (`ReferenceRefresher`,
`NativeDependencyReader`), esquema e codificação do Edit Data, orquestração de publicação e de módulo de template.

## 5. O modo local do dono

- O stdio, o CLI e `ssam serve --local-studios` continuam com a bridge completa: `studio-connect.mjs connectO11` põe no
  `.json` do gancho o `bridgePath` da compilação do kernel (a completa), e `ANVIL_BRIDGE_FLAVOR` só existe no ambiente
  montado por `hostedSpawnEnv`. O `BridgeClient` local segue pelo `Send`, que é o corpo de hoje.
- Por que não "fina + kernel local": exigiria o `ThinBridge` também no local, uma captura extra a cada `find_element`,
  perderia as dicas de `get_errors` lidas por `o11_studio errors` e `o11_publish`, e perderia `login`/`export_*` e
  `get_flow_nodes` que os scripts do dono usam. É mais mudança para o mesmo resultado. A completa dá mudança de
  comportamento zero.
- Garantias: `Dispatch.cs`, `MergeHandler.cs`, `Server.cs`, `EnvironmentSessionHandler.cs` e `LoginHandler.cs` da
  completa não mudam; o `BridgeKit` da completa só delega ao Anvil.Core; o resto é código movido. Provas: a completa
  compila, a fina compila (as duas estão em `kernel/Anvil.slnx`), e passam as classes de `Anvil.Tests` que compilam
  arquivos da bridge ou exercitam o merge (`ServiceCenterBridgeTests`, `ServiceCenterSecretRefsTests`,
  `PublishLogTests`, `PublishConfirmationTests`, `SilentModeTests`, `DialogPolicyTests`, `NativeReference*`).

## 6. O pacote do agente

### 6.1 Layout

Muda só a pasta da bridge O11 (FASE2 §6.2) e entra a do Node:

```
bin\o11\bridge\   Anvil.Bridge.dll (a fina) [+ Anvil.Bridge.deps.json]   e nada mais
agent\node\       node.exe + LICENSE                                     por padrão (§6.3)
```

### 6.2 Compilação (`scripts/agent-pack.ps1`)

- Compila `kernel\src\Anvil.Bridge.Thin\Anvil.Bridge.Thin.csproj` com `-p:SSDir=<Studio do kernel>` (sem
  `CopyLocalLockFileAssemblies`: a fina não tem pacote) no lugar de `Anvil.Bridge.csproj` (hoje linha 158).
- Arquivos obrigatórios: `connect\Anvil.Connect.dll`, `hook\Anvil.RuntimeHook.Agent.dll`, `bridge\Anvil.Bridge.dll`;
  sai `bridge\Anvil.Core.dll` (linha 164). Sai o aviso de binários do kernel (linha 145).
- `-NoBuild -Prebuilt <pasta>`: `<pasta>\o11\bridge\` traz a fina (`Anvil.Bridge.dll` e, opcional, o `.deps.json`).
- `pack.json` não muda de formato.

### 6.3 `node.exe` por padrão

- Sem `-NodeExe`, o script usa `Get-Node` (já existe, linhas 59-65: `SSAM_NODE`, o runtime em
  `%USERPROFILE%\.cache\codex-runtimes`, o `node` do PATH) e copia para `agent\node\node.exe`. Novo `-NoNode` deixa de
  fora (o cliente precisa então do Node 24).
- **Licença obrigatória.** Novo `-NodeLicense <arquivo>`. Ordem: `-NodeLicense`; senão `LICENSE` na pasta do
  `node.exe` ou na pasta acima. Copia para `agent\node\LICENSE`. Sem nenhum → recusa antes do ZIP: "Falta a licença do
  Node (LICENSE) para <node.exe>: use -NodeLicense <arquivo> ou -NoNode". O MIT do Node exige o aviso junto do binário.
  A fonte padrão de hoje (runtime do Codex, `...\dependencies\node\bin\node.exe`, v24.19.0) não tem `LICENSE` na pasta
  nem na pasta acima (conferido), então o pacote padrão é recusado até o dono fornecer o `LICENSE` oficial dessa versão
  (pergunta aberta 8).
- `agent\ssam-agent.ps1` já procura `agent\node\node.exe` primeiro (linha 22).
- Tamanho: o `node.exe` padrão tem 88,5 MiB; comprimido no ZIP com a mesma compressão `Optimal` do script, 33,1 MiB
  (medido).

### 6.4 Varredura de propriedade intelectual (`scripts/pack-ip-scan.ps1`)

`.\scripts\pack-ip-scan.ps1 -Zip <ssam-agent.zip>` lê cada entrada do ZIP, escreve
`{ok, findings:[{entry, rule, detail}], allowed:[{entry, rule, detail, why}]}` em JSON na saída e termina com 0 (sem
achados) ou 1. `agent-pack.ps1` a chama sobre o ZIP que acabou de escrever; com achados, apaga o ZIP e para com
`Varredura de PI falhou: <entrada> (<regra>)`; cada item de `allowed` vira um aviso. Regras:

1. **Nome proibido** (sem diferenciar maiúsculas, qualquer pasta): `.dll`, `.exe` ou `.pdb` cujo nome sem extensão é
   `anvil`, `anvil-odc` ou `Esprima`, ou começa com `Anvil.Core`, `Anvil.Cli`, `Anvil.Authoring`, `Anvil.CSharp`,
   `SSAM.License` ou `SSAM.Runtime`.
2. **Texto do kernel**: os bytes de toda entrada, exceto `agent/node/node.exe` e `agent/node/LICENSE` (terceiros), não
   podem conter, em UTF-8 e comparação exata, `Anvil.Core`, `Anvil.Cli`, `Anvil.Authoring`, `Anvil.CSharp`,
   `Ssam.Runtime`, `Ssam.Lic` nem `Esprima`. Nomes de namespace, tipo e assembly referenciado ficam em UTF-8 no heap
   `#Strings` dos metadados, então um tipo ou uma referência do kernel aparece aqui. Os textos literais em UTF-16 de
   `Anvil.RuntimeHook.Agent.dll` e `Anvil.Connect.dll`, que só citam `Anvil.Core` para recusá-lo, não casam.
3. **Pasta da bridge**: `bin/o11/bridge/` tem exatamente `Anvil.Bridge.dll` e, opcional, `Anvil.Bridge.deps.json`.
4. **Texto de cliente**: lê `scripts/release/client-content.json` (`forbidden[].pattern`, fontes de regex simples,
   válidas também em .NET) e procura cada padrão, sem diferenciar maiúsculas, nos bytes de toda entrada (as mesmas
   exceções da regra 2) decodificados como Latin-1 e como UTF-16LE nos dois alinhamentos, o mesmo método de
   `scripts/release/scan-client-content.mjs`. Achado → recusa, salvo a tabela fixa `$knownClientContent` do script
   (entrada, padrão, texto exato, número de ocorrências, motivo), cujos achados saem em `allowed`; uma ocorrência a
   mais, ou outra grafia do mesmo padrão na mesma entrada, é achado. A tabela começa com os dois textos de cliente que o
   código atual compila nas bridges do pacote e que só o overlay de release tira (nenhuma faixa pode editar esses
   arquivos, §1.3):
   - `bin/o11/bridge/Anvil.Bridge.dll` × `wright[\s_.-]?flood`: `ScGuard.Corporate` (`ScProtocol.cs:96`, na cópia
     da fina);
   - `odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v*.dll` × `wright[\s_.-]?flood` e × `andre\.c\.machado`: os
     padrões `Tenant`/`Author` de `platforms/odc/studio/shared/Manifest.cs:12-13`, que a bridge ODC compila (já no
     pacote da fase 2).

   A pergunta aberta 4 decide quando a tabela esvazia. Um texto de cliente novo em qualquer outra entrada recusa o
   pacote. **Desde `servidor/fase3` a tabela está vazia** e há a regra 5, `customer-pattern` (host de ambiente de
   cliente e e-mail); o gancho h1 tem a sua exceção de `kernel-text` (§13.1, §13.2).

A bridge completa casa a regra 2 (referencia `Anvil.Core`), então nunca passa por engano com o nome da fina.

### 6.5 A bridge ODC

`platforms/odc/studio/bridge/Bridge.csproj` compila `kernel/src/Anvil.Core.Odc/Adapters.ODC/OdcPublicSignature.cs`
(namespace `Anvil.Core`, 34 linhas que leem o XML da assinatura pública), usado uma vez em `ReferenceCommands.cs:33`.
Assim `ODC3.Bridge.v35.dll` carrega o tipo `Anvil.Core.OdcPublicSignature` e cairia na regra 2. Mudança: novo
`platforms/odc/studio/bridge/PublicSignatureReader.cs` (namespace global, `internal static class
PublicSignatureReader`, cópia do corpo), `Bridge.csproj` deixa de linkar o arquivo do kernel, `ReferenceCommands.cs:33`
chama `PublicSignatureReader.Read`. A versão da bridge (`v35`) não muda: o protocolo é o mesmo. Uma seleção assinada
antiga em `platforms/odc/.local/signed-runtime` ainda tem o tipo antigo e faz o pacote com ODC falhar na varredura até
ser renovada (pergunta aberta 2).

### 6.6 Agente

- `agent/lib/kinds.mjs` `O11_METHODS` = os verbos da §3.2 (saem `find_element` e `get_flow_nodes`; entra `refresh_references` na nona entrega, §14).
- `agent/lib/o11-connect.mjs` `probeBridge`: além de `protocolVersion:2` e `authentication:true`, exige
  `bridge_manifest.data.flavor === "thin"`. Uma bridge sem `flavor` respondendo na porta (a completa do dono, ou um
  pacote antigo) → `ATTACH_FAILED`: "A non-thin Anvil bridge answers on port <p>. The agent only talks to the thin
  bridge of its package; restart Service Studio." Nada é anexado. O resto do attach (FASE2 §4.9) não muda.
- Os testes da fachada que rodam o agente de verdade com uma bridge O11 falsa passam a responder `flavor:"thin"` no
  `ping` e no `bridge_manifest`: `platforms/odc/facade/tests/hosted-e2e.test.mjs:147-151` (que chama
  `ssam_connect {lane:"o11"}` na linha 205) e `fixtures/fake-studios-process.mjs` (do `hosted-e2e-processes.mjs`).

### 6.7 Documentos

- `docs/AGENTE-CLIENTE.md`: o Node não é mais pré-requisito (vem no pacote, com a licença); continuam o runtime .NET 8
  (conector O11) e o .NET 10 (cliente de attach ODC); a bridge O11 não leva o kernel.
- `docs/FASE2-AGENTE.md`, só estes trechos: a linha "Bridge O11" da tabela da §1; o parágrafo "Limite de tempo do
  kernel" da §4.6 (linhas 502-506, agora `ANVIL_BRIDGE_TIMEOUT_SECONDS=600`); o último item da §9.1 (linha 1013, o
  mesmo limite); a linha `bin\o11\bridge\` da §6.2; os itens O11 e `-NodeExe` da §9.4; os pré-requisitos da §9.5; os
  itens de propriedade intelectual e de "Ajuste de tempo do `BridgeClient`" da §11 (resolvidos por este documento); as
  perguntas 1, 6 e 11 da §12 marcadas como decididas, com link para este documento.

## 7. Decisões pequenas do dono

### 7.1 `node.exe` no pacote

Decidido (2026-10-05): vai por padrão (§6.3); `-NoNode` é a exceção. Sem licença, não vai (§6.3, pergunta 8).

### 7.2 Fixture neutra e evidência de terceiro

**Qual.** `kernel/tests/fixtures/odc/blank-crossdevice.oml`: um app ODC `CrossDevice` (o kind da fixture de hoje,
`OdcBlankModuleTests.cs:10`) em branco, criado offline pelo modelo instalado (`OdcBlankModule.Create`, chave derivada
de kind e nome), sem tenant, sem template e sem Studio. Gerado com:

```
dotnet <kernel>\.local\lane-odc\cli\anvil-odc.dll create-blank --kind CrossDevice --name SsamNeutralApp --out kernel\tests\fixtures\odc\blank-crossdevice.oml
```

com `ANVIL_DEVELOPER_ID` ausente (o autor fica `anvil@ssam-hybrid.local`, `OdcRuntime.cs:28`). Ao lado,
`blank-crossdevice.oml.json` no formato do sidecar existente: `{ok:true, module:"SsamNeutralApp", moduleKey, kind:
"CrossDevice", sha256 (hex maiúsculo), createdBy: "anvil-odc create-blank --kind CrossDevice --name SsamNeutralApp",
capturedAt, developerId: "anvil@ssam-hybrid.local", host: null, dependencies: []}`. Limite conhecido: não traz
OutSystemsUI, tema nem layouts; job de tela que dependa deles precisa de `base` = captura do módulo do cliente.

**Onde vale.** Só no hospedado:

- `ssam_job {lane:"odc"}` sem `base`: o portão (`hosted/policy.mjs`), depois de resolver os caminhos e antes do
  handler, põe `base` = caminho absoluto da fixture neutra no servidor. Sai `HOSTED_BASE_REQUIRED` (linhas 79-81 e
  223). O CLI ODC sempre recebe `--base` explícito no hospedado, então a base declarada no job (inclusive `job:` que
  termina na fixture de terceiro) nunca é usada. Com `base`, nada muda. A faixa O11 não muda (as fixtures O11 são do
  dono).
- Respostas: toda resposta de ferramenta hospedada passa por `scrubEvidence` (`hosted/evidence.mjs`) antes da
  apresentação (`present.result`), o que cobre `ssam_discover`, a orientação de falha de `ssam_job`/`o11_job`
  (`job-guidance.mjs` usa o índice direto, sem `discover()`) e `ssam_evidence`.

**Conjunto de jobs de terceiro.** `thirdPartyJobs()` lê uma vez por processo `kernel/tests/jobs-odc/*.json` e
`kernel/tests/jobs-odc-negative/*.json`. Um job é de terceiro quando a base declarada é
`tests/fixtures/odc/wrightflood-personal-r8.oml`, quando não declara base (por segurança; hoje todo job ODC declara),
quando o próprio texto (descrição, notas, mensagens esperadas) casa um `forbidden[].pattern` de
`scripts/release/client-content.json` (a lista da varredura de release; por segurança), ou quando a base é
`job:<nome>` de um job do conjunto (ponto fixo). Hoje: os 57 jobs de `jobs-odc` com a fixture direta, os encadeados
neles e os negativos sobre ela; ficam de fora os de `blank-mobile`, `blank-workflow`, `blank-agent`,
`blank-agent-definition` (por exemplo `workflow-nodes`, `agent-calls`, `mobile-sync-events`, `producer-service-event`,
`agent-definition-tools`). As descrições de `agent-calls`, `mobile-sync-events`, `workflow-nodes` e
`session-variable-mobile` citavam o módulo do cliente; passaram a dizer "uma app CrossDevice".

**Limpeza** (`scrubEvidence(result, jobs, {clientText})` devolve um resultado novo):

1. Em profundidade no `structuredContent`: um item de lista que é objeto com `job` no conjunto (nome puro ou
   `tests/jobs-odc/<nome>.json`), ou cujo `path`, `base` ou `fixture` cita `wrightflood-personal-r8`, sai da lista; o
   mesmo objeto como valor de campo vira `null` (exemplo: `identity.fixture`, ou uma entrada de `examples`).
2. Todo texto restante que cite `wrightflood-personal-r8` troca esse trecho por `<fixture omitida>`.
3. Só na resposta de `ssam_discover` (`clientText`, que o portão liga para essa ferramenta): todo texto (valores e
   chaves) que case um padrão de `client-content.json` troca o trecho por `<cliente omitido>`. Os catálogos do dono
   citam clientes fora dos jobs (um limite de capacidade do depurador, títulos do `NAO-DA.md`). As outras ferramentas
   não recebem essa troca: a resposta delas é o dado do próprio cliente (nomes dos módulos dele), que não pode ser
   reescrito. Limite: com `app`, o contexto da app do cliente na resposta do discover também passa pela troca.
4. Com alguma remoção, o resultado ganha `hostedEvidenceOmitted: <n>` no topo, e `continuation.omitted` deixa de
   oferecer a parte `example` de uma capacidade cujo exemplo a limpeza tirou (a expansão voltaria nula); uma entrada
   sem parte restante sai da lista.
5. Cada `content[].text` que era o JSON do `structuredContent` original é reescrito a partir do limpo; outro texto só
   recebe as trocas dos passos 2 e 3.

O nível de prova (`level`) de uma capacidade continua: é um resumo, não a evidência. Os jobs sobre fixtures neutras
(os `blank-*` e a nova) continuam aparecendo.

## 8. Faixas

### 8.1 Regras comuns

- Worktree próprio, a partir do commit deste documento:
  `git -C C:\Users\andre\SSAM-Hybrid-servidor worktree add -b fase3/<key> C:\Users\andre\SSAM-Hybrid-servidor-wt\<key> fase3/o11-thin`
  (git em `C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\Git\cmd\git.exe`).
- Montar: `powershell -File scripts\setup-dev.ps1 -Yes -NoUserEnv -SkipInstall -SkipMcp -SkipDoctor`.
- Em todo comando de teste e compilação: `ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`, `SSAM_ODC_OFFLINE=1`,
  `TEMP`=`TMP`=`C:\t\<key>` (curto: `agent-pack.ps1` estoura `MAX_PATH` com `TEMP` longo), `ANVIL_ODC_FEATURES_DIR` =
  cópia de `C:\Users\andre\AppData\Local\Temp\anvil-odc-work\odc-features\Features.xml`, e, para `Anvil.Tests` e
  compilações O11, `ANVIL_STUDIO_DIR` e `-p:SSDir=` = `C:\Program Files\OutSystems\Service Studio 11\Service Studio`.
  Node: `C:\Users\andre\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`.
- Cada arquivo tem UM dono (§8.2). Arquivo de outra faixa: só leitura; precisa de mudança alheia? Peça na resposta
  final citando a interface (§8.3). Ninguém edita arquivo com overlay de release (§1.3), `catalog/tools.json`,
  `scripts/release/client-content.json` (só leitura) nem este documento.
- Nada fora do próprio worktree. Nunca tocar, anexar, injetar ou matar um Studio; nunca rodar `Anvil.RuntimeHook` ou
  `Anvil.DebugTokenHook` contra processo; nada de workers, `ssam connect`, Service Center, tenant, publicação ou
  ferramentas `mcp__ssam*`; nunca mexer no servidor da porta 7300 nem no working tree do clone do servidor. Servidores
  de teste em 7400-7499, só os que a faixa sobe. Sem rede além de localhost. Nunca ler arquivo de credencial, cofre,
  cookie ou token.
- Sem dependência nova (npm ou NuGet). Código e comentários em inglês; documentos do dono em pt-BR.
- Commit com `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` = `Andre Machado` e `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL` =
  `andre_c_machado@hotmail.com`; mensagem terminando com linha em branco e
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Sem push.
- Regressão da fachada antes e depois: em `platforms\odc`,
  `node --test facade/tests/*.test.mjs portal/tests/*.test.mjs tests/*.test.mjs`. Falha que já existia na base não é
  regressão, mas vai citada.

### 8.2 Donos de arquivo

| Faixa | Arquivos (exclusivos) |
|---|---|
| `thin` | `kernel/src/Anvil.Bridge.Thin/**` (novo); `kernel/tests/Anvil.Bridge.Thin.Tests/**` (novo); em `kernel/src/Anvil.Bridge/`: `BridgeKit.cs`, `ReadsKernel.cs`, `PublishLogResolver.cs` (novos) e as edições mecânicas de `ScOperations.cs`, `ScApiHandler.cs`, `Studio.cs`, `ExportHandler.cs`, `Reads.cs`, `Dialogs.cs`, `PublishLogHandler.cs` (§2.3); `kernel/tests/Anvil.Tests/Anvil.Tests.csproj` (só a linha de `BridgeKit.cs`); `kernel/Anvil.slnx` (só as duas linhas da §2.3) |
| `server` | `kernel/src/Anvil.Core/Adapters.SS11/BridgeClient.cs`; `kernel/src/Anvil.Core/Adapters.SS11/ThinBridge.cs` (novo); `kernel/tests/Anvil.Tests/ThinBridgeTests.cs` (novo); `platforms/odc/facade/executor.mjs` (só `hostedSpawnEnv`); `platforms/odc/facade/tests/executor.test.mjs` |
| `pack` | `scripts/agent-pack.ps1`; `scripts/pack-ip-scan.ps1` (novo); `agent/**`; `platforms/odc/studio/bridge/Bridge.csproj`, `platforms/odc/studio/bridge/ReferenceCommands.cs`, `platforms/odc/studio/bridge/PublicSignatureReader.cs` (novo); `platforms/odc/tests/public-signature-drift.test.mjs` (novo); `platforms/odc/facade/tests/hosted-e2e.test.mjs`; `platforms/odc/facade/tests/hosted-e2e-processes.mjs`; `platforms/odc/facade/tests/fixtures/fake-studios-process.mjs`; `docs/AGENTE-CLIENTE.md`; `docs/FASE2-AGENTE.md` (só os trechos da §6.7) |
| `neutral` | `kernel/tests/fixtures/odc/blank-crossdevice.oml` e `blank-crossdevice.oml.json` (novos); `kernel/tests/Anvil.Tests.Odc/OdcBlankModuleTests.cs`; `platforms/odc/facade/hosted/policy.mjs`; `platforms/odc/facade/hosted/evidence.mjs` (novo); `platforms/odc/facade/hosted/tools.json` (só o `reason` de `ssam_job`); `platforms/odc/facade/tests/hosted-policy.test.mjs`; `platforms/odc/facade/tests/hosted-evidence.test.mjs` (novo) |

### 8.3 Interfaces entre faixas

- **I-1 Fio da fina** (implementa `thin`; consome `server` no `ThinBridge` e `pack` na lista do agente): §3 inteira.
  Os 20 verbos e `flavor:"thin"` são o que o agente confere.
- **I-2 Identidade do assembly** (implementa `thin`; consome `pack`): projeto
  `kernel/src/Anvil.Bridge.Thin/Anvil.Bridge.Thin.csproj`, propriedade `SSDir`, saída única `Anvil.Bridge.dll`
  (+ `.deps.json`), entrada `public static Anvil.Bridge.Server.Start(int)` (e `Start(int, string, string)`), nenhum
  texto UTF-8 da regra 2 da §6.4.
- **I-3 `reference_plan`** (produz `server`; consome `thin`): JSON da §3.3, `Analyze(base, candidato, base)`,
  obrigatório em todo `merge_from_oml` com `base_path`.
- **I-4 Variáveis** (as duas pontas em `server`): `ANVIL_BRIDGE_FLAVOR=thin`, `ANVIL_BRIDGE_TIMEOUT_SECONDS=600`, só
  em `hostedSpawnEnv('o11')`.
- **I-5 Fixture neutra** (cria e usa `neutral`): caminho `kernel/tests/fixtures/odc/blank-crossdevice.oml`.
- **I-6 Varredura** (implementa `pack`; `thin` a satisfaz pela I-2): regras da §6.4. A fina carrega o texto
  `wrightflood` de `ScProtocol.cs:96` e por isso está na tabela `$knownClientContent`.

### 8.4 Faixa `thin`: a bridge fina

Construir: o projeto da §2.1 com os arquivos da §2.2, as edições da §2.3 (inclusive `kernel/Anvil.slnx`) e o
`BridgeKit` da §2.4; o projeto de testes `kernel/tests/Anvil.Bridge.Thin.Tests` (net8.0, xunit, como `Anvil.Tests`),
que referencia o projeto da fina e o `Anvil.Core` (os testes podem; o DLL entregue não) e carrega as DLLs do Studio de
`ANVIL_STUDIO_DIR` como `Anvil.Tests` (`StudioAssemblies.Bind`).

Pares base/candidato para os testes de merge: `NativeReferencePairs.cs` no projeto de testes, cópia dos passos de
geração de `NativeReferenceVersionMergeTests.cs` (`Contract` 326-341, `Freeze` 125-136, `Apply` 137-147, a mutação de
`ExplicitHashMerge` 191-209), só com APIs públicas do `Anvil.Core`/`Anvil.CSharp` (`ModelHost.PlanModuleSpecification`,
`JobRunner.Run`, `FrozenFrameworkDependencies.Create/ReferenceOperations/ProducerBindings`,
`NativeReferenceSnapshot.Read/Bind`, `FrameworkIntrinsic`, `Publisher.Mutate`, `ModelHost.Load/Save/Release`). Gera
em tempo de teste, numa pasta temporária, a partir de `tests/fixtures/blank-service.oml` e de
`tests/contracts/native-reference/ordinal-primitive.avsig` e `text-primitives.avsig`, como o teste original; nenhum
OML gerado é commitado (sairia velho a cada versão do Studio). A raiz do repositório é calculada no próprio teste
(`JobRunner.RepoRoot` é `internal`).

Testes que têm de passar, sozinha:

- Fronteira: os metadados do `Anvil.Bridge.dll` compilado da fina (System.Reflection.Metadata) têm nome `Anvil.Bridge`,
  referências só a `System.*`, `Microsoft.*`, `netstandard`, `OutSystems.*`, `ServiceStudio.*`, `Avalonia.*`,
  `WebViewControl.Avalonia` e `Xilium.CefGlue`, nenhum tipo definido ou referenciado em namespace que comece com
  `Anvil.Core`, `Anvil.Cli`, `Anvil.Authoring`, `Anvil.CSharp` ou `Ssam.`, nenhum texto da regra 2 da §6.4 nos bytes, e
  `public static Anvil.Bridge.Server.Start(int)` e `Start(int, string, string)`.
- Verbos: a tabela é exatamente a da §3.2; `ping`/`bridge_manifest` com `flavor:"thin"`; verbo desconhecido e os cinco
  removidos → `executed:false`.
- Paridade de plumbing com o Anvil.Core: `BridgeKit` (chaves, `Absolute` inclusive as mensagens de erro, `Project` em
  DTOs do Studio, classificação de diálogo numa tabela de títulos/textos/interfaces, `InterfaceProp` com implementação
  explícita de interface); `Authority` × `BridgeAccess` (`ResolveDirectory`, `KeyPath`, `Matches`, recusa do
  `Require`); `SnapshotRegistry`, `MergeJournal` (os arquivos de um são lidos pelo outro) e `MessageDelta` nas mesmas
  entradas.
- Mensagens: `NativeMessages.Messages` × `ModelHost.Messages` em `tests/fixtures/blank-service.oml` e
  `tests/fixtures/reactive-ui.oml` carregados headless, comparando o JSON serializado (`JsonSerializer.Serialize` da
  lista) byte a byte: nomes `id`/`type`/`key`/`path`/`detail` nessa ordem, sem `IsError`, `key` idêntico; o mesmo para
  o `MessageDelta` (`new`/`fixed`/`preexisting`) e para o `JsonSerializer.Deserialize<List<Anvil.Core.MessageInfo>>`
  do JSON da fina, que tem de devolver os mesmos registros.
- Plano (I-3): para cada par, `reference_plan` = `SerializeToNode(ReferenceSignatureMerge.Analyze(base, candidato,
  base))`, lido pela fina. Um `merge_from_oml` com `base_path` e sem `reference_plan`, ou com JSON ilegível →
  `executed:false` antes do diário (teste da conferência de parâmetros, sem Studio). `RequireComplete` recusa: o plano
  sem a mudança do produtor; `ForeignHash`, `BaseHash` ou `BaseReferenceKey` trocados; uma mudança a mais para um
  produtor de hash igual; um produtor ambíguo sem conflito. Aceita o plano verdadeiro e um plano com conflito no lugar
  da mudança.
- Seleção de referência, espelhando TODOS os cenários de `NativeReferenceVersionMergeTests` (linhas 19-43) e os quatro
  de `NativeReferenceAtomicMergeTests.SequentialTreesShareUndoAndRollbackInMemory`, com o plano do servidor
  (`Analyze(base, candidato, base)`), o modelo vivo preparado como no teste original e
  `ReferenceSelections.MergeInCurrentCommand` com `tree.Merge()` dentro de `Publisher.Mutate`. Em todos:
  `Effective(vivo, plano)` tem as mesmas `Changes` que `Analyze(vivo, candidato, base)` e o mesmo conjunto de
  `(ProducerKey, Code)` em `Conflicts`.
  - `normal`: 2 merges nativos, 1 selecionada, o apelido local `LocalRuntimeAlias` retido, o mesmo hash retido que
    `ReferenceSignatureMerge.MergeInCurrentCommand` no mesmo par;
  - `metadata-only`: 1 merge nativo, 1 selecionada;
  - `noop` (base = candidato): plano vazio, 0 e 0;
  - `local-equal` (vivo = candidato): `Effective` sem mudanças, 0 e 0, `VerifyRetained` passa;
  - `hash` (hash vivo trocado por um terceiro valor): `Effective` com `concurrent-signature`; `MergeInCurrentCommand`
    lança antes de qualquer chamada nativa, com o código no texto, hash, apelido e produtor vivos intactos;
  - `producer` (`ReferenceKey` vivo trocado, mesma `Key` e mesmo hash, `NativeReferenceVersionMergeTests.cs:201-206`):
    `Effective` com `producer-identity-changed`; `MergeInCurrentCommand` lança antes de qualquer chamada nativa, com o
    código no texto;
  - `hash-after-plan` (hash trocado dentro do comando, antes da chamada): lança antes de qualquer chamada nativa e o
    comando desfaz;
  - `invalid-foreign` (`ReferenceHash` do candidato vazio): o plano do servidor traz `invalid-foreign-signature`, e
    `MergeInCurrentCommand` recusa o plano com conflito.
- Fio da `environment_session`: o JSON (`IncludeFields`) de cada registro de `EnvironmentWire.cs` é igual ao do registro
  do kernel com os mesmos valores; `EnvironmentPrimitives.Execute` sobre um `IServiceCenter` falso (`DispatchProxy`) dá
  o mesmo `value` que `EnvironmentOperations.Execute(HeadlessSession.Borrow(falso, ...))` em `applications`, `modules`,
  `versions`, `catalogs`, `referenceable`, `download` (pasta temporária), `application-save`, `application-delete`,
  `publish-start` e `publish-check`; concessão `readOnly` recusa as escritas; `data-*` recusa `(System)` e `Users`.

Comandos: `dotnet build kernel\src\Anvil.Bridge.Thin\Anvil.Bridge.Thin.csproj -c Release -p:SSDir=<SS>`;
`dotnet build kernel\src\Anvil.Bridge\Anvil.Bridge.csproj -c Release -p:SSDir=<SS>`;
`dotnet build kernel\Anvil.slnx -c Release -p:SSDir=<SS>`;
`dotnet test kernel\tests\Anvil.Bridge.Thin.Tests -c Release -p:SSDir=<SS>`;
`dotnet test kernel\tests\Anvil.Tests -c Release -p:SSDir=<SS> --filter "FullyQualifiedName~ServiceCenterBridgeTests|FullyQualifiedName~ServiceCenterSecretRefsTests|FullyQualifiedName~PublishLogTests|FullyQualifiedName~PublishConfirmationTests|FullyQualifiedName~SilentModeTests|FullyQualifiedName~DialogPolicyTests|FullyQualifiedName~NativeReference"`.

### 8.5 Faixa `server`: o kernel no lugar do Studio

Construir: `ThinBridge` e a mudança de `BridgeClient` da §4.1 a §4.4; as duas variáveis em `hostedSpawnEnv` (§4.5).

Testes que têm de passar, sozinha:

- `kernel/tests/Anvil.Tests/ThinBridgeTests.cs` (numa coleção sem paralelismo, restaurando as variáveis de ambiente):
  - sem `ANVIL_BRIDGE_FLAVOR`, `BridgeClient` contra um ouvinte TCP do teste (porta em 7400-7499, `ANVIL_AUTHORITY_DIR`
    temporário) manda exatamente a linha de hoje;
  - com `thin`, os verbos de repasse chegam ao `send` falso sem mudança;
  - `login`, `export_modules`, `export_status` e `get_flow_nodes` lançam `BridgeCallException` com
    `Executed == false` sem chamar `send`;
  - `merge_from_oml` com base leva `reference_plan` igual a `SerializeToNode(ReferenceSignatureMerge.Analyze(base,
    candidato, base))` em dois pares: base = candidato (plano vazio) e um par feito no teste trocando, por
    `Publisher.Mutate`, o `ReferenceHash` de uma referência existente de uma fixture commitada que tenha referência
    (a faixa escolhe a fixture e afirma `HasChanges`); um `reference_plan` posto pelo chamador é substituído; sem base,
    nenhum plano;
  - falha antes de enviar: `merge_from_oml` com `base_path` que não é OML lança `BridgeCallException` com
    `Executed == false` e o `send` não recebe `merge_from_oml`; e, de ponta a ponta, `Delivery.Run` com um
    `IBridgeClient` de teste que delega a um `ThinBridge` sobre um `send` falso (no formato do `Bridge` de
    `DeliveryResumeTests.cs:131-149`, cuja captura escreve um texto que não é OML) termina com `writeState`
    `not-sent`, sem `merge_from_oml` no `send`;
  - `find_element` pede um `snapshot_module` (caminho sob `Path.GetTempPath()\thin-bridge`, alvos repassados), apaga a
    cópia, reaproveita a captura na segunda chamada e tira outra depois de um verbo diferente. Oráculo (o `Reads.Find`
    da completa precisa de `Studio.Active()` e da thread de UI de um Studio vivo, e `Anvil.Tests` não referencia
    `Anvil.Bridge`): (1) valores fixos no teste sobre uma fixture commitada, com pelo menos um nome de `count ≥ 1`
    (forma `{query, count, results:[{name, type, key, parent}]}` e valores exatos), um nome em outra caixa e um nome
    de `count = 0`, e um `max` que corta; (2) a mesma expressão de `Reads.Find` (`EntityIndexes.IncludeNative`,
    `ModelHost.Prop` de `Name`/`Label`, `EntityIndexes.TypeName ?? ModelHost.Kind`, pai por `Name`) avaliada no teste
    sobre o `ESpace` da mesma fixture. A comparação com o `Reads.Find` vivo é item da prova ao vivo (§8.8);
  - `EffectiveTimeout` é o máximo.
- `executor.test.mjs`: `hostedSpawnEnv('o11')` tem `ANVIL_BRIDGE_FLAVOR=thin` e `ANVIL_BRIDGE_TIMEOUT_SECONDS=600`;
  `hostedSpawnEnv('odc')` não tem nenhuma das duas.
- Regressão: `dotnet test kernel\tests\Anvil.Tests -c Release -p:SSDir=<SS> --filter "FullyQualifiedName~ThinBridgeTests|FullyQualifiedName~NativeReference|FullyQualifiedName~DeliveryTests|FullyQualifiedName~DeliveryResumeTests"`
  e a regressão da fachada (§8.1).

### 8.6 Faixa `pack`: pacote, varredura, agente

Construir: §6.1 a §6.7.

Testes que têm de passar, sozinha:

- `agent/tests/pack.test.mjs` com `-NoBuild -Prebuilt` (árvores falsas; as chamadas que não testam o Node passam
  `-NoNode`, para nunca copiar o `node.exe` real de 88,5 MiB): a fina falsa gera o layout da §6.1 e `pack.json` com
  sha256 certos; `bin/o11/bridge` só com `Anvil.Bridge.dll` (e `.deps.json`); `Anvil.Core.dll` em qualquer pasta →
  recusa, sem ZIP no fim; uma DLL com `Anvil.Core` em UTF-8 nos bytes → recusa; o mesmo texto só em UTF-16 → aceita;
  cada outro texto da regra 2 → recusa; arquivo extra em `bin/o11/bridge` → recusa; regra 4: um padrão de
  `client-content.json` em UTF-16LE (por exemplo `unimed`) no cliente ODC falso → recusa; `wrightflood` em UTF-16LE na
  fina falsa → aceita, com o item em `allowed` e o aviso; o mesmo texto em outra entrada → recusa; Node: `-NodeExe`
  com arquivo falso pequeno e `LICENSE` ao lado → os dois copiados; sem `LICENSE` → recusa, sem ZIP; com
  `-NodeLicense` → copiado; `-NoNode` omite os dois; o `node.exe` não passa pelas regras 2 e 4.
- `agent/tests/o11.test.mjs`: o attach só segue com `flavor:"thin"` no manifesto; bridge sem `flavor` → `ATTACH_FAILED`
  sem attach; o `.json` do gancho continua com `bin\o11\bridge\Anvil.Bridge.dll`.
- `agent/tests/kinds.test.mjs`: `find_element`, `get_flow_nodes`, `login`, `export_modules` → `METHOD_NOT_ALLOWED`; os
  20 passam.
- `platforms/odc/tests/public-signature-drift.test.mjs`: o corpo de `PublicSignatureReader.Read` é o de
  `OdcPublicSignature.Read`, normalizados namespace, nome da classe, visibilidade e brancos.
- `dotnet build platforms\odc\studio\bridge\Bridge.csproj -c Release` compila e o DLL resultante não tem nenhum texto
  da regra 2.
- `node --test platforms/odc/facade/tests/hosted-e2e.test.mjs` passa com a bridge O11 falsa respondendo
  `flavor:"thin"` (linhas 147-151).
- `node platforms\odc\facade\tests\hosted-e2e-processes.mjs` passa com o layout novo (a bridge O11 falsa do e2e
  responde `flavor:"thin"`; o pacote com `-NoNode`).
- `node --test agent/tests/*.test.mjs` na raiz do worktree.

### 8.7 Faixa `neutral`: fixture neutra e evidência

Construir: §7.2 (fixture, sidecar, `base` padrão no portão, `hosted/evidence.mjs` com `thirdPartyJobs()` e
`scrubEvidence(result, jobs)`, chamada de `scrubEvidence` em `wrapHostedTool` antes de `present.result`, `reason` de
`ssam_job` em `hosted/tools.json`).

Testes que têm de passar, sozinha:

- `dotnet test kernel\tests\Anvil.Tests.Odc -c Release --filter FullyQualifiedName~OdcBlankModuleTests` com a linha
  nova `[InlineData("CrossDevice", "blank-crossdevice")]` (a fixture commitada é `CrossDevice` e serve de base).
- `hosted-policy.test.mjs`: `ssam_job {lane:"odc"}` sem `base` chega ao handler com `base` = caminho absoluto da
  fixture neutra (substitui o caso `HOSTED_BASE_REQUIRED`); com `base`, igual; `lane:"o11"`, igual; a resposta passa por
  `scrubEvidence`.
- `hosted-evidence.test.mjs`: `thirdPartyJobs` sobre um catálogo temporário (base direta, cadeia `job:`, sem base) e
  sobre o catálogo real (contém os 57 de base direta de `jobs-odc`, exclui os `blank-*`); `scrubEvidence` sobre uma resposta sintética
  do discover (listas `proofs`, `examples`, `evidence`, `bindings`, `notes`, `negative`, `ran`, mapa `examples`,
  `identity.fixture`, texto em `content`) não deixa nome do conjunto nem `wrightflood-personal-r8`, mantém um job neutro
  e conta `hostedEvidenceOmitted`.
- Regressão da fachada (§8.1).

### 8.8 Integração e aceitação

- Ordem: `thin` → `server` → `neutral` → `pack` (o pacote real e o e2e precisam do projeto da fina).
- Aceitação depois da integração: `dotnet build kernel\Anvil.slnx`; `Anvil.Bridge.Thin.Tests` e `Anvil.Tests`
  inteiros; regressão da fachada; `node --test agent/tests/*.test.mjs`;
  `agent-pack.ps1 -Out C:\t\int\ssam-agent.zip -Lanes odc,o11 -NoNode` compilando de verdade (com a seleção assinada
  ODC renovada ou ausente, §6.5) passa na varredura, com `bin\o11\bridge` só com a fina e com os itens de `allowed` da
  regra 4 listados na resposta; com o `LICENSE` do Node fornecido pelo dono, o mesmo sem `-NoNode` leva
  `agent\node\node.exe` e `LICENSE`; `hosted-e2e-processes.mjs`.
- Prova ao vivo com o dono, depois. O que os testes offline não provam, e a prova tem de cobrir:
  1. Carregar a fina pelo `Anvil.RuntimeHook.Agent` num Service Studio 11.55.91 que NÃO foi aberto pelo atalho
     "Service Studio (SSAM)" do dono (esse já carrega a completa: o gancho recusa um segundo `Anvil.Bridge` e o agente
     responde `ATTACH_FAILED`), numa porta diferente da 4516 da faixa do dono.
  2. Chamar cada um dos 20 verbos uma vez (`TypeLoadException`/`MissingMethodException` só aparecem no primeiro JIT);
     conferir `bridge.key` e a ACL dele em `private\authority`.
  3. `merge_from_oml` com `reference_plan` por `CompareAndMergeCommands.Merge(aggregator, tree)` dentro de
     `Command.Execute` (os testes offline usam `tree.Merge()`): `VerifyRetained` depois da limpeza do comando, Ctrl+Z
     desfazendo estrutura e `ReferenceHash` juntos, edição concorrente de hash e de produtor no Studio vivo recusada
     antes de qualquer mutação (`merged:false` antes do comando, `executed:false` dentro), `merge_status` repetindo o
     recibo.
  4. Paridade do plano para um produtor republicado de verdade: `Analyze` headless no servidor × `Analyze` dentro do
     Studio, inclusive `desired.IsValid`.
  5. `find_element` por captura pelo relay e pelo espelho × `Reads.Find` vivo, com o tempo de um módulo grande abaixo
     de 600 s e dentro do orçamento de 900 s do CLI.
  6. `get_errors` sem dicas e a verificação do `Delivery`; `publish` e `publish_log` sem o resolvedor (elemento só de
     `ExtraInfo`).
  7. `environment_session` sobre o login SSO real do cliente: concessão, validação, expiração de 1 h, leituras,
     espelho do `download`, assinatura por REST e SOAP, `data-read`; escritas só com o consentimento do dono; recusa
     `readOnly`; segredo ausente das respostas e de `%LOCALAPPDATA%\Anvil\bridge-<porta>.log`.
  8. O laço de diálogo do `open_module`, `windows`/`close_dialog`/`ui_alive`, e `sc_*` com o cofre do cliente.
  9. Controle Inteligente de Aplicativos bloqueando a DLL não assinada numa máquina de cliente.

## 9. Fora de escopo e limites conhecidos

- A prova ao vivo (§8.8) e a assinatura de código (Controle Inteligente de Aplicativos).
- O servidor não recusa um agente de pacote antigo (bridge completa); o agente novo recusa bridge sem `flavor`
  (pergunta aberta 3).
- Pacote novo com servidor da fase 2 (`acba66d8`, sem `ThinBridge`): todo `merge_from_oml` é recusado `executed:false`
  (sem `reference_plan`, §3.3) e `find_element` é recusado pelo agente (`METHOD_NOT_ALLOWED`); nada é escrito. O dono
  atualiza o servidor antes de distribuir o pacote novo.
- O cliente hospedado não vê as dicas do kernel em `get_errors` nem a resolução de nome no log de publicação;
  `get_flow_nodes` não existe no hospedado.
- O carimbo de proveniência de um `ssam_job` ODC hospedado ainda leva `fixtureSha256` da fixture da faixa
  (`Anvil.Cli.Odc/Program.cs:131`, com overlay): só o hash, sem conteúdo.
- As capturas de `find_element` ficam em `agent:o11/tmp/` na máquina do cliente (o agente não limpa).
- Textos de cliente conhecidos nas bridges do pacote (§6.4 regra 4) até a pergunta aberta 4. Resolvido (§13.1).
- O pacote hospedado carrega a fina com o gancho de DESENVOLVIMENTO (`Anvil.RuntimeHook.Agent.dll`, compilado do
  fonte por `agent-pack.ps1`): ele põe `ANVIL_AUTHORITY_DIR` no processo do Studio do cliente, chama `Start(int)` e
  carrega a bridge da pasta sem conferir manifesto, comportamentos que a linha de release tirou (W8, W9). A fina já tem
  a entrada do gancho de release, `Start(int, string, string)` (log e autoridade por parâmetro, sem ler o ambiente),
  mas o gancho de release (ABI `h1`) ainda exige o manifesto assinado do release (`Ssam.Lic.Release`) e `pid` e
  `bridgeId` no `bridge_manifest`, que a fina não dá. Levar a fina para a linha de release é um passo à parte, pelos
  overlays. **Atualizado em `servidor/fase3` (§13.2):** a fina dá `pid` e `bridgeId`, e o pacote `-Hook h1` usa o gancho
  de release com o manifesto assinado; o gancho de desenvolvimento continua o padrão até a linha de release entregar o
  `Anvil.Hook.h1.dll`.

## 10. Perguntas abertas

1. A guarda do merge de assinaturas (§3.3, cerca de 150 linhas: seleção nativa de `ReferenceHash`, cobertura do plano
   sobre os bytes, metade viva de `Analyze`) vai na fina. Aceitar, ou recusar no hospedado os merges com troca de
   assinatura de produtor?
2. A seleção assinada do runtime ODC (`platforms/odc/.local/signed-runtime`) traz `Anvil.Core.OdcPublicSignature`.
   Renovar a assinatura com a bridge ODC nova, ou empacotar a bridge ODC não assinada até lá?
3. O servidor deve recusar um agente de pacote antigo (bridge completa), por exemplo com um campo no `pack.json`
   conferido pelo hub?
4. Textos de cliente compilados nas bridges que vão ao cliente: `wrightflood` em `ScGuard.Corporate`
   (`ScProtocol.cs:96`, fina e completa) e o tenant `wrightflood.outsystems.dev` e o e-mail corporativo do dono nos
   padrões de `Manifest.cs:12-13` (bridge ODC, já no pacote da fase 2). Os dois arquivos têm overlay de release que já
   tira esses textos, e nenhuma faixa pode editá-los. Autorizar uma faixa a trazer a mudança do release para o dev
   (lista de hosts corporativos sem nome fixo; padrões vazios) regenerando os dois patches de overlay, ou manter a
   tabela de exceções da varredura (§6.4 regra 4) até lá? **Decidida:** os textos saíram do código e a tabela esvaziou (§13.1).
5. Decidida: sim. A fina e os testes dela entram em `kernel/Anvil.slnx` (§2.1).
6. Túnel do primeiro testador: **decidida (2026-10-05)**, o túnel rápido da FASE2 §9.1, pelo `scripts\tunel.ps1` (§13.3).
7. Há outras capturas de cliente em `kernel/tests/fixtures` (por exemplo `hmisjha/HMISJHA_CS-v5578.oml`), hoje sem job
   que as use de base. Aplicar a mesma limpeza a elas?
8. Licença do Node: o pacote padrão é recusado sem o `LICENSE` do `node.exe` (§6.3), e a fonte padrão de hoje não o
   tem. Fornecer o `LICENSE` oficial do Node 24.19.0 (vem no ZIP oficial da distribuição) por `-NodeLicense`, apontar
   `SSAM_NODE` para uma distribuição oficial com o `LICENSE` ao lado, ou commitar o texto da licença no repositório
   para o script usar? **Respondida:** o dono forneceu o `LICENSE` oficial por `-NodeLicense` (§13.4).

## 11. Rastreabilidade da revisão 1

| Achado da crítica | Onde |
|---|---|
| M1 identidade do produtor no modelo vivo | §3.3 passo 3 (`Effective`) e `MergeInCurrentCommand` 1, 3, 5, 6; testes de todos os cenários na §8.4 |
| M2 plano ausente ou incompleto | §3.3: `reference_plan` obrigatório com base, guarda de cobertura no passo 2; testes na §8.4; §9 |
| M3 falha do `ThinBridge` antes de enviar | §4.1 "Falha antes de enviar é `executed:false`"; teste de ponta a ponta na §8.5 |
| M4 `hosted-e2e.test.mjs` sem dono | §6.6, §8.2 (faixa `pack`), §8.6 |
| S1 mudanças efetivas antes da tabela | §3.3 passos 3 e 4 |
| S2 mudança deliberada de comportamento | resolvida por M1: com a metade viva de `Analyze` na fina, a mudança concorrente responde como na completa (§3.3, fim) |
| S3 `get_flow_nodes` sem emulação | §0, §1.2, §4.1, §4.3; teste na §8.5 |
| S4 oráculo do `find_element` | §8.5 (valores fixos + mesma expressão no teste; vivo na §8.8 item 5) |
| S5 origem de base/candidato nos testes da fina | §8.4 (`NativeReferencePairs.cs`, gerado em tempo de teste, nada commitado) |
| S6 referências inexistentes | §2.1 (20 referências) |
| S7 nome de terceiro no binário | §1.2, §6.4 regra 4, §8.3 I-6, §9, pergunta 4 (inclui `Manifest.cs` da bridge ODC, achado nesta revisão) |
| S8 licença do Node e tamanho | §6.3, §7.1, pergunta 8 |
| S9 pergunta 5 | §2.1, §2.3, §5, §8.2, §8.4, §8.8; pergunta 5 decidida |
| S10 paridade das mensagens por JSON | §3.4, §8.4 |
| S11 conhecimento que ainda vai na fina | §0 |
| S12 consistência | §6.3 (linha 22), §6.7 (§4.6, §9.1 e §11 da FASE2) |
| S13 o que só a prova ao vivo mostra | §8.8 |

## 12. A oitava entrega na linha do servidor (`servidor/fase3`)

O merge de `integracao/consolidacao` (`3a958183`: motor determinístico, modelos do `studio_create_app`, cobertura,
leitor nativo, bridge ODC v37) sobre `fase3/o11-thin` (`ec57a4d6`). O que a junção exigiu além do texto dos dois lados:

- **Ordem do merge na fina.** A completa ganhou `first_pass_path`/`first_pass_sha256` no `merge_from_oml` e a
  capacidade `merge_from_oml:first_pass`; o `Delivery` recusa com `BRIDGE_OUTDATED` quando a bridge não a tem e o job
  adia defaults. A fina faz o mesmo: dois merges nativos numa chamada, um `operation_id`, um recibo (`MergeReceipt`,
  cópia provada por `PlumbingParityTests`). O `ThinBridge` calcula o `reference_plan` sobre a cópia de primeira passada,
  que é o que o primeiro merge carrega; o segundo merge não seleciona referência.
- **Caminho novo no fio.** `first_pass_path` é entrada: o espelho (`hosted/o11-stage.mjs`) o envia por sha256 e o
  agente (`agent/lib/kinds.mjs`) o confina como `foreign_path`. Sem isso o merge do hospedado receberia um caminho do
  servidor. O e2e de processos prova a ordem do merge pelo relay (check 9c).
- **Bridge ODC v37 sem tipo do kernel.** A v37 linkava `kernel/src/Anvil.Core/Kernel/MergeOrder.cs` (namespace
  `Anvil.Core`), o que a varredura de PI recusaria (§6.4 regra 2). Agora compila `bridge/MergeOrderCopy.cs` (namespace
  global, mesmos nomes, `internal`), igual ao do kernel por `public-signature-drift.test.mjs`, como na §6.5.
  `engine/NativeMergeOrder.cs` e `StartupHook.cs` não têm mais `using Anvil.Core`; `Anvil.Tests.Odc` liga os tipos do
  kernel por `EngineKernelTypes.cs`.
- **`studio_create_app` hospedado.** A bridge v36+ informa a pasta de plugins de modelo do ODC Studio. No hospedado
  essa pasta é da máquina do cliente (e o agente escolhe o texto): o kernel do servidor nunca a recebe em
  `--plugins-dir`, porque um plugin de modelo é código que ele carrega. Lê o cache de plugins do próprio servidor.
- **Versão da bridge ODC nos testes.** Os e2e não fixam mais `v35`: leem a versão de
  `studio/bridge/client/Program.cs` (`tests/fixtures/odc-bridge-version.mjs`), a mesma que o servidor pede.
- **Fica para o dono:** a linha de release ainda tem overlays obsoletos (a oitava entrega mudou
  `Anvil.Bridge/Dispatch.cs`, `MergeHandler.cs` e `Anvil.Cli/Program.cs`, que têm overlay; o de `ScProtocol.cs` foi
  refeito na §13). A fina não passa pela tecelagem nem pelos overlays.

## 13. Pendências fechadas na linha do servidor (`servidor/fase3`, depois de `1a0955fd`)

### 13.1 Texto de cliente fora de tudo o que vai ao cliente

- `ScGuard.Corporate` (`ScProtocol.cs`, completa e fina, cópias iguais) não tem mais nome fixo. Lê `corporateHosts` de
  `%USERPROFILE%\.ssam-hybrid\config.json` (campo e arquivo do contrato de runtime, `DISTRIBUICAO.md` §4), a cada
  escrita. Um nome vale também para os subdomínios. Arquivo ilegível ou campo fora do formato recusa a escrita.
- Sem o campo, decide `BridgeKit.CorporateWhenUnconfigured`: a completa (dono e release) não conta nenhum host como
  corporativo, e a guarda de hosts da fachada (`hosts.json`) continua valendo; a fina conta TODO host como corporativo
  (falha fechada): uma escrita do Service Center precisa de `corporateInstruction`, que o servidor só manda depois das
  palavras que nomeiam o ambiente. A mensagem de recusa diz qual regra valeu.
- Para manter a guarda dupla local do tenant corporativo, o dono grava `corporateHosts` no próprio `config.json`.
- O overlay de release de `ScProtocol.cs` foi refeito sobre o arquivo novo: troca só `ConfigFile` por
  `Ssam.Runtime.RuntimeContract.ConfigFile` (a mesma pasta, uma fonte só).
- `Manifest.cs` da bridge ODC não tem mais tenant nem autor padrão; `Load` recusa manifesto sem os dois. Todo gravador
  (kernel, builder, `anvil-deliver.mjs`) já os escreve. O overlay de `Manifest.cs` saiu, porque o checkout ficou igual
  ao release (`owners.json`: `EDIT`).
- Varredura (`scripts/pack-ip-scan.ps1`): a tabela `$knownClientContent` está vazia; nova regra `customer-pattern`
  recusa host de ambiente de cliente (`<nome>.outsystems.dev`, `.outsystems.app`, `.outsystemscloud.com`,
  `.outsystemsenterprise.com`) e endereço de e-mail, com as mesmas leituras da regra 4. Passam os hosts do fornecedor
  (`id.outsystems.com`) e os domínios reservados de exemplo. Testes em `agent/tests/pack.test.mjs`.
- Pacote real de 2026-10-05 (`-NodeLicense`): varredura sem achado e sem exceção.

### 13.2 A fina no gancho de release (ABI `h1`)

- **Bridge.** `bridge_manifest` da fina diz `pid`, `bridgeId` (o nome da pasta `b<N>` de `studio\o11\bridge\b<N>`;
  nulo fora dele), `hookAbi:"h1"`, `ideVersion` e `bridgeSha256` (sha256 do próprio arquivo). É o que o
  `Anvil.Hook.h1` espera (`pid` e `bridgeId`) para dar o recibo `ok`. A fina já tinha `Start(int, string, string)`.
  Continua com os 20 verbos: sem `retire` (atualizar = reiniciar o Studio).
- **Pacote.** `agent-pack.ps1 -Hook h1 -HookH1 <pasta>` leva o gancho de release pronto (`studio\o11\hook\
  Anvil.Hook.h1.dll`; o script nunca o compila, porque ele só sai de uma staging tecida, com as raízes do publicador) e
  a fina em `studio\o11\bridge\b1\`, com `release.json` na raiz (`ssam-agent-release/1`). Dois passos com a assinatura
  no meio: `-Stage <pasta>` monta a árvore e para; o dono assina com `release_sign {releaseDir}` (servidor MCP do
  publicador); `-FromStage <pasta> -Out <zip>` confere que `release.sig.jws` lista cada arquivo com tamanho e sha256 e
  só então compacta e varre. Sem `-Stage`, `-Hook h1` é recusado. A varredura aceita `Ssam.Lic` e `Ssam.Runtime` só
  dentro do gancho h1 e confere o layout (uma bridge `b<N>`, a pasta do gancho fechada, `release.json` e
  `release.sig.jws` presentes, nunca as duas pastas de bridge juntas).
- **Agente.** Com `pack.json` `o11Hook:"h1"`: confere a cobertura do manifesto assinado ANTES do único attach (um pacote
  alterado não queima o attach desta execução do Studio), escreve `request-b1.json` na pasta de troca do contrato
  (`%USERPROFILE%\.ssam-hybrid\data\o11\runtime-connect\<pid>-<início ms>`), anexa o gancho no lugar (nada ao lado da
  DLL), espera o recibo e recusa um recibo `ok:false` (`manifest_*`) sem repetir. Um recibo que já existe recusa antes
  do attach. Os dados da bridge ficam em `private\o11-bridge`; a autoridade em `private\authority`.
- **Aperto de mão de versão** (os dois ganchos): o agente só usa a bridge se `bridgeSha256` for o do `pack.json`
  (`o11Bridge.sha256`) e, com h1, `hookAbi:"h1"` e `bridgeId:"b1"`. Senão `BRIDGE_VERSION_MISMATCH`, nada mais é enviado
  (nem a chave) e a bridge fica carregada sem uso: reiniciar o Studio. O registro de conexão ganha `hook`, `bridgeId` e
  `bridgeSha256`; o `hello` leva `pack.o11Hook`.
- **Servidor.** O hub recusa um gancho desconhecido no pacote (`AGENT_PACK_MISMATCH`). Com `kernel.json`
  `{"o11Hook":"h1"}` o dono aceita só pacotes com o gancho de release.
- **Nunca troca DLL carregada.** O gancho h1 recusa recarregar um `bridgeId`; o agente recusa Studio com Anvil já
  carregado e não repete attach (marcador por pid, início e porta).
- **Limite.** A prova com um `Anvil.Hook.h1.dll` real (gêmeo de teste ou release) depende da linha de release:
  `tests/runtime-connect.integration.mjs` já prova o gancho com bridges falsas quando `SSAM_HOOK_H1_DIR` e
  `SSAM_DEV_KEYS` existem. Aqui tudo foi provado com falsos (agente, pacote, varredura, hub).

### 13.3 Exposição pelo túnel rápido

`scripts\tunel.ps1` (repassa para `scripts\tunel.mjs`), que só o dono roda: `start [--port N]` sobe o servidor
hospedado pelo `servidor.ps1` (só `127.0.0.1`), recusa se o processo da porta não for esse servidor (nunca
`--local-studios`), sobe `cloudflared tunnel --url http://127.0.0.1:<porta> --http-host-header 127.0.0.1:<porta>
--no-autoupdate --logfile <pasta>\tunnel.log` sem console e mostra a URL `https://<aleatório>.trycloudflare.com` com a
configuração do cliente (`Bearer ${SSAM_TOKEN}`, nunca um token). `stop [--server]`, `status`, `config [--url]`,
`plan`. Nunca baixa o cloudflared. Testes só com falsos (`tests/tunel.test.mjs`). Roteiro: [PROVAS-AO-VIVO.md](PROVAS-AO-VIVO.md).

### 13.4 Respostas às perguntas da §10

- 4: decidida. Os textos saíram do código (13.1) e a tabela de exceções esvaziou.
- 6: decidida (2026-10-05). Túnel rápido da FASE2 §9.1, pelo `scripts\tunel.ps1`.
- 8: o dono forneceu o `LICENSE` oficial do Node 24.19.0 (`-NodeLicense C:\t\node-license\LICENSE`); o pacote padrão
  sai com `agent\node\node.exe` e `LICENSE`.
- Continuam abertas: 1 (aceite da guarda de assinaturas na fina, pendente da prova ao vivo 3), 2 (seleção assinada
  ODC, ainda inexistente), 3 (agora parcialmente: o hub recusa gancho desconhecido e, com `kernel.json`, pacote sem h1)
  e 7.

## 14. A nona entrega na linha do servidor (`servidor/fase3`)

O merge de `integracao/consolidacao` (`ce7c6b25`: pacote de correções de 2026-10-05, bridge ODC v38, 79 ferramentas)
sobre `48df9944`. O que a junção exigiu além do texto dos dois lados:

- **Verbo novo na fina.** `refresh_references` (C26, o Refresh References do próprio Studio) entra na fina pelo mesmo
  arquivo da completa (`RefreshReferencesHandler.cs`, por link). O arquivo não usa mais tipo do kernel: a contagem de
  erros é `Reads.ErrorCount` de cada bridge (`ReadsKernel.cs` na completa, `ReadsThin.cs` na fina). A fina passa a ter
  21 verbos. O agente aceita o verbo (`agent/lib/kinds.mjs`): ele não tem caminho, então não há o que confinar.
- **Capacidades.** A fina anuncia as mesmas da completa, na mesma ordem: `merge_from_oml:rollback_proof`,
  `merge_from_oml:module_key`, `get_errors:generation`, `publish:wait_running`, `publish:dialogs_seen`,
  `list_open_modules:server_operation` e `refresh_references`, mais `thin` e `merge:reference-plan`. O teste
  `VerbsAndCapabilitiesFollowTheFullBridge` lê o `Dispatch.cs` da completa: uma capacidade que o kernel confere
  (`Delivery.HasCapability`) nunca chega a uma bridge e falta na outra.
- **Prova de rollback (C15).** `MergeRollbackProof.cs` é puro e entra por link. O `MergeHandler` da fina ganhou o
  `RollbackReceipt` da completa: sha256 do módulo vivo contra o `baseHash` do diário e, se diferir, uma `MatchTree`
  nativa do vivo sobre a base. Provado, o diário grava `not-applied` e o módulo fica livre.
- **Geração da validação (C28).** `settle` e `generation` ficam em `Reads.cs` (compartilhado). Os dois `get_errors`
  esperam o Studio ocioso (até 30 s) e respondem `settled` e `generation`.
- **`module_key` em qualquer aba (C41).** `Studio.Target` é do `Studio.cs` compartilhado. `snapshot_module`,
  `merge_from_oml` e `get_errors` da fina usam a aba do `module_key`, como a completa.
- **Publicação (C31, C10) e Service Center (keep-alive).** Vêm pelos arquivos compartilhados (`PublishHandler.cs`,
  `ScWebHandler.cs`, `ScApiHandler.cs`). `ScProtocol.cs` é cópia: foi copiado de novo (`CopiedFilesTests`), e o
  overlay de release foi refeito sobre o arquivo novo (só `ConfigFile` troca, como na §13.1).
- **Mensagens.** O `MessageInfo` do kernel ganhou `ownerKey` e `screenKey`. A cópia da fina (`MergeSupport.cs`) serializa
  igual, e `NativeMessages.ScreenKeyOf` copia `ModelHost.ScreenKeyOf` (`MessageParityTests`).
- **Bridge ODC v38.** Os e2e leem a versão de `studio/bridge/client/Program.cs`. O pacote leva `ODC3.Bridge.v38.dll`.
- **Cópias do transporte no agente.** `agent/lib/odc-pipe.mjs` (com `pipeProbe`) e o bloco de `agent/lib/o11-wire.mjs`
  (cancelamento e o prazo de `refresh_references`) seguem a fachada (`agent/tests/drift.test.mjs`).
- **Falso do e2e de processos.** `fixtures/fake-studios-process.mjs` responde os 21 verbos, as capacidades novas,
  `get_errors` com `settled`/`generation` e `refresh_references`.
- **Fica para o dono:** a prova ao vivo de `refresh_references` e do rollback na fina (o mesmo código da completa, mas
  ainda não rodado num Studio de cliente). Entra no roteiro de [PROVAS-AO-VIVO.md](PROVAS-AO-VIVO.md) junto da prova 3.

## 15. A décima sexta entrega na linha do servidor (`servidor/fase3-16`)

Produto `b01cef95` (`consolidacao/main`). A bridge completa ganhou o verbo `integration_import` e cinco capacidades.

- A fina continua com os 21 verbos. `integration_import` fica de fora: valida e monta o candidato com
  `Anvil.Core.IntegrationImport` e tipos de entrega do kernel. Um job com import SOAP/OpenAPI é recusado antes de
  qualquer captura (`INTEGRATION_IMPORT_NEEDS_BRIDGE`).
- A fina serve `sc_api:integration-studio` (`ScApiHandler` ligado, mais `ScIntegrationStudioSoap.cs` ligado, puro) e
  `sc_web:studioSession` (`ScWebHandler` ligado e a cópia nova de `ScProtocol.cs`).
- A fina não serve `integration_import:wsdl`, `integration_import:openapi` nem `environment_session:users-read`
  (`Anvil.Core.UserDirectory`). A busca de usuários recusa com `STUDIO_BRIDGE_OUTDATED` antes de qualquer chamada.
- `DispatchTests.VerbsAndCapabilitiesFollowTheFullBridge` lê a lista da completa e tira só essas três (`NotServed`) e o
  verbo `integration_import` (`Removed`). `EnvironmentParityTests` tira `users-read` (`KernelOnly`).
- A lista fechada do agente (21 métodos O11) não mudou. Na ODC, a v39 trouxe `portal-upload`; ele não entra na lista do
  agente porque só o `odc_external_library` o usa, e essa ferramenta é indisponível no hospedado.
- Os testes .NET da fina pedem `ANVIL_STUDIO_DIR` apontando para o Service Studio usado na compilação (`SSDir`). Sem
  isso, o `StudioAssemblies.Bind` carrega o Studio da faixa (outra versão) e o `ESpace.Load` cai com
  `OutOfMemoryException`.