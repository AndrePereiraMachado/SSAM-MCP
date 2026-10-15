# Desenvolvimento do SSAM

Este guia é só para quem desenvolve o SSAM: kernel, bridges, builder, fachada e testes.
Sessão de app não lê este arquivo. Ela trabalha só pelo MCP `ssam`, com as regras do `AGENTS.md` da raiz.
Por que a separação: `docs/CONTEXTO-FIXO.md`.

## Raiz e componentes

- Esta é a raiz única. Estado da migração: `docs/MIGRACAO.md`. Layout: `.ssam-workspace.json`.
- Não reintroduza caminhos absolutos dos checkouts anteriores. Eles são cópias preservadas, não dependências nem destino de trabalho novo.
- Os arquivos históricos de evidência mantêm seus caminhos. Não reutilize esses manifests para entregar.
- `kernel/`: núcleo Anvil, adaptadores C# O11/ODC, CLIs e testes. Antes de mudar o kernel, leia as seções de `kernel/AGENTS.md` que a tarefa pede.
- `kernel/AGENTS.md` também alimenta `ssam_reference {kind:"recipe"}` e os testes de guia (`GuideTests`): cada job citado existe e cada job de `tests/jobs` é citado.
- `platforms/odc/`: bridge, builder, Portal e jobs ODC. Leia `platforms/odc/AGENTS.md` e `platforms/odc/docs/HANDOFF.md`.
- `facade/`: entrada da raiz e configuração das raízes e portas. A implementação MCP está em `platforms/odc/facade/`.
- Fontes compartilhadas compilam nas duas plataformas. Builds e suítes de uma mesma plataforma são sequenciais.

## Toolchain

Na ordem do `scripts/setup-dev.ps1`:
- git: PATH, `%ProgramFiles%\Git\cmd\git.exe`, `%ProgramFiles%\Microsoft Visual Studio\*\*\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\Git\cmd\git.exe`;
- node 22+: `SSAM_NODE`, `%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`, PATH;
- python 3.11+: `SSAM_PYTHON`, `...\dependencies\python\python.exe`, `py -3`, PATH;
- dotnet SDK 10+: PATH, `%ProgramFiles%\dotnet\dotnet.exe`.

## Build e testes

- Máquina nova: `COMECE-AQUI.md` e `scripts/setup-dev.ps1`.
- Worktree de desenvolvimento, sem worker (cerca de 40 s):
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-dev.ps1 -Yes -NoUserEnv -SkipInstall -SkipMcp -SkipDoctor`.
- Build e suíte isolados: `ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`, `SSAM_NO_WARM=1`, `TEMP`/`TMP` curtos e privados,
  `ANVIL_ODC_FEATURES_DIR` com uma cópia privada do `Features.xml` e `ANVIL_STUDIO_DIR` com a pasta do Service Studio.
- Testes Node: `pnpm test` (raiz, fachada, Portal e `platforms/odc/tests`). Testes C#:
  `dotnet test kernel\tests\Anvil.Tests -c Release` e `dotnet test kernel\tests\Anvil.Tests.Odc -c Release`.
- Não rode a suíte da fachada enquanto uma suíte do kernel do mesmo worktree grava selos de job.
- Rotas do discover: `platforms/odc/facade/catalog/tools.json`. O teste `tool-routes.test.mjs` as mantém completas contra o servidor.
- Contexto fixo das sessões (instruções, descrições e esquemas das ferramentas): `node platforms/odc/scripts/contexto-fixo.mjs`.

## Teste nativo de SQL e Aggregate

Teste direto de SQL/Aggregate: [contrato e prova viva pendente](TESTE-NATIVO-QUERY.md).
MCP `ssam_query_test`, preparação e recibos compartilhados em `kernel/query-test/`,
bridges nativos de ambas as faixas. Testes offline próprios em `kernel/query-test/tests`;
não substituir por `sc_api TestQuery`, que permanece bloqueado.

## Extensões .NET O11 (XIF) sem Integration Studio

- Ferramenta MCP `o11_extension` (`platforms/odc/facade/o11-extension.mjs`). Kernel `kernel/src/Anvil.Xif` (net8) e motor `kernel/src/Anvil.Xif.Engine` (net472, x86).
- O `setup-dev` compila o motor em `kernel\.local\xif-engine` quando há Service Studio. Falha dele é aviso; a ferramenta responde `XIF_ENGINE_UNAVAILABLE`.
- O motor acha o Integration Studio instalado nesta ordem: `ANVIL_INTEGRATION_STUDIO_DIR`, registro do Windows (desinstalação), `Program Files\OutSystems\Integration Studio`.
  Não há referência de compilação a DLL da OutSystems: tudo é reflexão sobre a instalação.
- Outro executável do motor: `ANVIL_XIF_ENGINE` (caminho do `Anvil.Xif.Engine.exe`).
- CLI, um JSON por comando: `anvil xif check --spec <json> [--base <xif>]`, `anvil xif read --xif <arquivo>`,
  `anvil xif build --stage model|final ... --work <pasta>`, `anvil xif diff --base <xif> --new <xif>`.
- Os assemblies de referência do .NET Framework 4.7.2 vêm do pacote MIT `Microsoft.NETFramework.ReferenceAssemblies.net472` e ficam em `ref\net472` ao lado do `Anvil.Xif.dll`.
- As DLLs da plataforma de cada ambiente ficam em cache em `kernel\.local\xif-deps\<host>\<versão>\<sha256>.zip`. Nunca vão para o Git nem para o pacote.
- Testes: `dotnet test kernel\tests\Anvil.Tests -c Release --filter "FullyQualifiedName~Xif|FullyQualifiedName~ServiceCenterBridge"`
  e, em `platforms\odc\facade`, `node --test tests\o11-extension.test.mjs tests\o11-publish.test.mjs`.
  `XifInstalledEngineTests` roda os estágios `model` e `final` no Integration Studio instalado, sem rede; sem motor ou sem Integration Studio, retorna cedo.
- O motor cria objetos do Integration Studio só por `R.New` (construtor conferido pelos argumentos), nunca por `Activator`.
  Exceção inesperada dentro dele é `XIF_ENGINE_FAILED` (defeito do SSAM, não do spec).
- Documento da tarefa e provas ao vivo pendentes: `kernel/docs/tasks/2026-10-05-o11-xif-headless.md` e `kernel/docs/tasks/2026-10-06-xif-motor-construtor.md`.

`o11_extension {action:"publish", referencesFrom:["ExtensaoExistente"], spec, ...}` resolve as bibliotecas no mesmo
ambiente durante a entrega: fixa versão e hash do XIF fonte, exporta as DLLs referenciadas que não são da plataforma,
inclui as licenças e notices, recusa DLLs conflitantes e passa pela checagem de closure antes de compilar.
Não exige caminhos de DLL nem uma chamada de leitura separada. `referenceSources` registra a origem no recibo.

`o11_extension {action:"read"}` exporta também os recursos do XIF para uma pasta privada nova:
`exported.resources` traz caminho lógico, arquivo local, SHA-256, deploy e codeReference;
`exported.references` traz as DLLs referenciadas que não são da plataforma. Uma nova extensão pode usar esses
caminhos em `spec.references`, preservando as licenças pertinentes em `spec.resources`. A verificação existente
confere a closure das DLLs. Não há resolução automática de NuGet. Internamente:
`anvil xif read --xif <arquivo> --resources-out <diretório novo absoluto>`; sem a opção, continua só descritivo.

## Regras do produto

- Nenhuma edição direta de modelo aberto: candidato headless e merge nativo com base, hash e recibos.
- Nunca substituir DLL carregada. Bridge ODC novo exige versão nova. Sem automação de teclado ou mouse.
- `lab`, snapshots, journal, `.local`, caches e builds ficam fora do Git. Não apagar evidências automaticamente.
- Credenciais ficam no armazenamento privado do usuário, nunca em prompt ou repositório.

## Atrito

- Registro automático desde 20/09/2026: `docs/FRICCAO-AUTOMATICA.md`.
- CLI e MCP pelos launchers da raiz registram metadados e falhas em `.local/friction/`. Leia com `ssam friction issues` ou MCP `ssam_friction`.
- Comandos nativos fora do launcher não são cobertos. Fila não é notificação.
- Resultado incerto continua proibindo repetir escrita sem reconciliar recibos. O registro não corrige a causa.

## Pacotes e versões

- Versão funcional liberada: `docs/USAR-VERSAO-FUNCIONAL.md` (MCP `ssam-functional`, pacote `readonly-2d8facfa2c136a73`).
- Pacote de leitura aprovado: `ssam package run --operation version` e `ssam package help`; MCP `ssam-headless-selected`. Só leitura.
- Uma sessão MCP aberta conserva seu pacote. Não selecione um candidato de `.local/stabilization` por ser mais recente.
- MCP: `.mcp.json` da raiz, regenerável com `node scripts/configure-mcp.mjs`. Comandos manuais: `.\ssam` e `.\odc` da raiz.
- Num worktree de desenvolvimento (`.git` é arquivo), o `configure-mcp` registra o servidor `ssam-dev-<pasta>` e tira o `ssam` herdado. Na raiz principal o nome continua `ssam`. Ele só escreve os `.mcp.json` desta pasta.
- Uma entrada MCP por servidor. O `configure-mcp` recusa gravar uma segunda entrada que rode o servidor SSAM da mesma raiz com outro nome (`DUPLICATE_MCP_ENTRY`): a entrada existente fica, e a resposta diz o nome dela.

## Identidade do servidor e release trocada

- `ssam_doctor` traz sempre `server {name, root, release, startedAt}` (`platforms/odc/facade/server-identity.mjs`).
- A release que conta é só o que o processo MCP carregou (`platforms/odc/facade/facade-identity.mjs`):
  - `facadeSha256`: os `.mjs` e `.json` de `platforms/odc/facade/**` (fora `tests/`), de `platforms/odc/portal/runtime/**` e os `.mjs` de `facade/`;
  - `catalogSha256`: `catalog/tools.json`, `catalog/fragments/**` e `discovery-capabilities*.json`;
  - `launcherSha256`: `facade/launch.mjs` e `facade/friction-*.mjs`, que o processo pai carrega.
  - O commit (`head`) e a CLI O11 são só informação: kernel, CLI e motor XIF rodam por chamada.
- `WRONG_SERVER`: a raiz SSAM da sessão é outra pasta. A raiz vem dos roots MCP do cliente; sem eles, da pasta de onde o cliente lançou o servidor (`SSAM_CLIENT_CWD`, posto por `facade/launch.mjs`).
- Recarga no lugar: o `facade/launch.mjs` compara a identidade antes de cada `tools/call` sem nada pendente. Mudou a fachada ou o catálogo: sobe um filho novo, reenvia o `initialize` do cliente e repassa a chamada. Catálogo mudado também avisa `notifications/tools/list_changed`. O doctor mostra `server.reloadedAt` e `server.reloadedFrom`.
- `TOOL_CATALOG_STALE` (doctor) e `RELEASE_CHANGED` (toda ferramenta, menos `ssam_doctor`, `ssam_evidence` e a leitura do `ssam_task`) ficam para o que a recarga não cobre: mudança em `facade/launch.mjs` ou `facade/friction-*.mjs`, ou recarga impossível por requisição pendente. Aí reconecte o servidor MCP.
- Mudança só de kernel, CLI ou motor XIF não dispara nada.
- O discover tira do índice a capability com ponteiro quebrado e a nomeia em `dropped`. Problema de esquema do descritor ainda recusa o build.

## Reservas de módulo O11

- `<authority>/reservations/<sha>.json` guarda `owner`, `environment`, `moduleKey`, `root` (raiz kernel), `pid` e `since` (`kernel/src/Anvil.Core/Delivery/ModuleReservation.cs`).
- Conflito na mesma raiz: `MODULE_RESERVED` (texto `resume task <id>`). Em outra raiz: `MODULE_RESERVED_FOREIGN` com raiz, pid e data.
- O doctor classifica cada reserva: `active`, `stale`, `foreign` ou `orphan`. Só `active` e `stale` desta raiz levam a `ssam_task`.
- Reserva de uma task da sessão de app controlada (`app-sessions.json` da authority) é sempre `active`: só aquela sessão a resolve.
- `ssam_doctor {lane:"o11", release:{reservation, authorize}}` libera uma reserva `foreign` ou `orphan` com as palavras do usuário. Grava `owner:null`, `releasedBy:"doctor"` e o sha256 das palavras. Uma entrega rodando segura a reserva (`RESERVATION_IN_USE`).

## Studio O11 sem congelar (08/10/2026)

- Nenhuma chamada do bridge prende a UI thread do Studio nem espera por ela sem prazo (`kernel/src/Anvil.Bridge/UiGate.cs`, `Ui.cs`).
- Todo passo na UI thread usa `Ui.Run` com prazo. Passo que não começou é retirado da fila (`Abort`) e responde `UI_BUSY` com `executed:false`. Passo que começou responde resultado desconhecido.
- Nunca `Dispatcher.UIThread.Invoke`, `.Wait()`, `.Result` ou `GetAwaiter().GetResult()` sobre trabalho da UI sem `Ui.Run`/`Ui.RunSync`.
- `close_module` só fecha aba ociosa (`ModuleGate`): sem publicação, sem publicação headless, sem frame aninhado e com a sonda de ociosidade da aba concluída. Senão `MODULE_BUSY`, nada fechado. Causa: o `Close()` do Studio espera, na UI thread, a fila da própria aba; o fim de uma publicação nessa fila precisa da UI thread.
- `publish` espera a aba ficar ociosa (até 45 s) e responde `settled`. `open_module` e `publish` esperam a publicação headless do mesmo módulo (`HeadlessPublications`).
- Fachada: chamada do bridge que estoura o prazo fica "em voo" e bloqueia a próxima escrita daquele Studio até a resposta tardia (`registerBridgeFlight`).
- A fila de escrita de um Studio fica na pasta da autoridade dele (`<authorityDir>/studio-locks`), comum a todas as raízes.
- `o11_studio wait idle|no-dialogs` são escritas: entram na fila e não contam a si mesmas. `status` só responde o diálogo de dependências com o Studio livre.
- Processo do Studio sem janela: `STUDIO_STARTING` (ainda abrindo) ou `STUDIO_WINDOWLESS` com pid, hora e o passo exato. O SSAM nunca encerra um Studio.
- Provas: `kernel/tests/Anvil.Tests/UiFreezeTests.cs`, `platforms/odc/facade/tests/ui-freeze*.test.mjs`. Prova viva pendente.

## Referências

### Prompt de credenciais ODC (2026-10-14)

`portal/runtime/credential-prompt.mjs` e `windows-credential-prompt.ps1` substituem o lançamento
detached sem confirmação. O helper gerencia somente sua própria janela, usa mutexes por contexto,
confere PID/instante de criação/handle e atende pedidos de foco na thread da própria UI.
`odc_portal_login` expõe `prompt` e `focus`; `status` não cria janelas.
`OdcAccess.openPrompt` não usa mais tempo decorrido como evidência de janela aberta.
Prova e limitações: [prompt ODC](proofs/2026-10-14-odc-credential-prompt.md).

O broker também reconhece o login pessoal em `id.outsystems.com/community/login`, mantendo
o PKCE e o estado do Portal, a identidade do perfil escolhido e a confirmação por leitura protegida.
O login do Portal tem orçamento de 90 s. Prova de autenticação e releases:
[OutSystems ID da comunidade](proofs/2026-10-14-odc-community-auth.md).

O prompt legado de banco O11 não foi migrado por esta mudança. A falha de janela não visível
observada nessa rota permanece separada; não atribuir a ela a prova de visibilidade do ODC.

### Service Center: autenticação e timers (2026-10-14)

- Leituras do Service Center têm orçamento de 90 s, incluindo SSO frio. O processo privado tem até 65 s (sempre limitado ao orçamento restante), para comportar descoberta, inicialização e a chamada de identidade de até 45 s. As demais leituras mantêm o padrão de 29 s, exceto o login do Portal ODC, descrito acima.
- Chamadas simultâneas da mesma identidade compartilham uma autenticação em voo; cada chamada recebe seu próprio jar, somente com cookies do Service Center. Host, principal, perfil e Studio continuam separados. Erros locais de validação/layout não invalidam uma sessão autenticada; falhas de autenticação invalidam.
- `Schedule` do O11 é validado no compilador DDL antes de criar elementos e no setter antes de salvar. O Service Center recusa ativar uma agenda nativa inválida antes de reservar/enviar. Exemplos nativos: `03:00`, `00:05 Mon`, lista `00:00 00:05 ... 23:55`; o setter também aceita `{ "everyMinutes": 5 }`. Prosa não é agenda.
- `timer-run` faz a verificação de leitura na própria chamada e retorna `outcome`, `requestStatus`, `executionObserved`, `executionCompleted`, `attributedToRequest` e `evidence`. Os outcomes são `scheduled`, `execution-observed`, `execution-failed`, `not-sent`, `not-executed`, `timer-absent` ou `unknown`. `unknown` tem o código `TIMER_RUN_OUTCOME_UNKNOWN` e continuação `verify`, nunca um reenvio. Um novo log ou mudança de Last Run comprova a execução observada, não qual escritor a disparou. Uma observação exata resolve o recibo pendente sem repetir o POST.
- Provas e comandos de teste: [autenticação e timers](proofs/2026-10-14-service-center-auth-timers.md).

### Payload histórico de integração O11

`o11_service_center_read {action:"integration-log-detail", host, requestKey, logAction, moduleId?}`
liga o Request Log ao XLSX de integrações e à linha nativa pela ação, módulo e instante exatos.
Reaplica os filtros explicitamente, inclusive All, para não herdar seleções de outra chamada.
Segue apenas um link de detalhe de leitura observado naquela linha; nunca refaz a chamada REST/SOAP.
Um detalhe disponível precisa confirmar Request Key, Action, Module e Time of Log antes de expor
os campos Request/Response, com segredos mascarados. Layouts de payload ainda não vistos ao vivo
continuam sujeitos à validação por contrato, sem atribuir prova viva aos testes sintéticos.

`payloadStatus` distingue `available`, `not-exposed`, `not-recorded`, `permission-denied`,
`event-not-found`, `ambiguous-event`, `incomplete-list` e detalhes/layouts não suportados.
`not-recorded` exige mensagem explícita da plataforma; ausência de link responde
`SC_INTEGRATION_PAYLOAD_NOT_EXPOSED` com `recordingStatus:unknown`.
Páginas Permission denied/Access denied agora retornam `SC_PERMISSION_DENIED` antes da análise de layout.
Prova real e regressões: [payload de integração](proofs/2026-10-14-o11-integration-payload.md).

- Leitura: `docs/LEITURA-RAPIDA.md` (mapa e índice por captura) e `docs/LEITURA-MODELO.md`.
- Lógica em texto (`ssam-flow/1`: a ida da etapa LG1, com ponto fixo provado no corpus do plano, e a volta da LG2 pela op
  `logic` com `data.flow`, com a bateria de edições; screen, block e data actions nascem do texto com o dono no cabeçalho,
  com a bateria de criação `FlowCreateBattery`): `docs/TEXTO-LOGICA.md`.
- Preview local ODC/O11: `docs/PREVIEW-LOCAL.md`.
- Descoberta contextual: `docs/DESCOBERTA-CONTEXTUAL.md`. Pacote de trabalho (`ssam_discover {packet:true}`, `work-packet.mjs`): §1.5. Studio da faixa O11 na descoberta: §2.3.
- Conexão com o Studio aberto: `docs/CONEXAO-STUDIO.md`.
- Dados O11 headless: `docs/O11-DADOS-HEADLESS.md`.
- Debugger: `docs/DEBUGGER-HEADLESS.md`; continuidade em `docs/HANDOFF-DEBUGGER-HEADLESS-2026-10-03.md`.
- Ambiente O11 com SSO: `kernel/docs/proofs/2026-09-25-o11-connected-environment.md`.
- URLs de apps e telas: `docs/URLS-APPS.md`.
- Credenciais do Service Center e do Portal (janela privada, cofre, perfis por host, revogar, trava corporativa): `docs/SC-PORTAL-USO.md`.
