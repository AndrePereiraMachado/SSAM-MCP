# Provas ao vivo da linha do servidor (uma sessão com o dono)

Este roteiro fecha o que os testes offline não provam: as 9 provas da §8.8 de [O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md).
É uma sessão só, com o dono presente. Cada passo tem o comando exato, o resultado esperado e uma linha "Se falhar".
Marque cada caixa. Anote o resultado na tabela do fim.

Tudo aqui roda na máquina do dono. O "cliente de teste" é uma pasta nesta mesma máquina: `C:\SSAM-Agent-Teste`.

## Regras da sessão

- Só ambientes de teste: o ambiente O11 pessoal e um tenant ODC pessoal. Nunca o tenant corporativo.
- Escrita só num módulo O11 de teste e num app ODC de teste que o dono escolher. Cada entrega leva as palavras do dono.
- O servidor da fase 1 que já roda na porta 7300 fica como está. Ele dirige os Studios do dono: nunca o exponha.
  A sessão usa a porta **7310**.
- O Service Studio da prova abre pelo atalho NORMAL. O atalho "Service Studio (SSAM)" já carrega a bridge completa:
  o gancho recusa uma segunda `Anvil.Bridge` e o agente responde `ATTACH_FAILED`.
- A bridge O11 do agente usa a porta **4566** (`--o11-port`), diferente da 4516 da faixa do dono.
- Token e credencial do agente vão para o cofre de senhas. Nunca para chat, arquivo do repositório ou print.

## Antes do dia (preparo, sem Studio)

- [ ] **P1. Código.** No clone do servidor: `git merge servidor/fase3`, depois
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-dev.ps1 -Yes -SkipMcp`.
  Esperado: tabela final toda "ok". Se falhar: o registro detalhado está em `.local\setup\setup-*.log`.
- [ ] **P2. cloudflared.** `winget install --id Cloudflare.cloudflared`, depois `cloudflared --version`.
  Esperado: uma versão. Se falhar: baixe o MSI oficial da Cloudflare; o script nunca baixa nada.
- [ ] **P3. Studios.** Service Studio 11.55.91 e ODC Studio 1.7.27 instalados (as versões do kernel do servidor).
  Se falhar: o `ssam_doctor` do passo 4 mostra `STUDIO_VERSION_MISMATCH`; instale a versão do kernel.
- [ ] **P4. Testes offline verdes.** `node --test agent\tests\*.test.mjs` e
  `node platforms\odc\facade\tests\hosted-e2e-processes.mjs`. Esperado: 58/58 e 72/72 (16ª entrega). Se falhar: não siga para a sessão.

## Passo 1. Servidor e túnel

- [ ] **1.1 Plano (nada sobe).** `.\scripts\tunel.ps1 plan --port 7310`
  Esperado: JSON com `servidor.ps1 start -Port 7310` e
  `cloudflared tunnel --url http://127.0.0.1:7310 --http-host-header 127.0.0.1:7310 --no-autoupdate --logfile ...`.
  Se falhar: confira o Node (`$env:SSAM_NODE`) e o cloudflared (`--cloudflared <exe>`).
- [ ] **1.2 Subir.** `.\scripts\tunel.ps1 start --port 7310`
  Esperado: "Servidor no ar", "Tunel no ar", a URL pública `https://<aleatório>.trycloudflare.com` e o JSON do
  cliente com `Bearer ${SSAM_TOKEN}`. Anote a URL: ela muda a cada start.
  Se falhar: "porta ocupada" → outra porta; "--local-studios" → o servidor da porta não é o hospedado, não siga;
  "não mostrou a URL" → leia `.local\server\tunnel.log`.
- [ ] **1.3 De fora.** `curl.exe -s https://<url>/health`
  Esperado: `{"ok":true,"pid":<pid do servidor>}`, o mesmo pid de `.\scripts\servidor.ps1 status`.
  Se falhar: espere 30 s (a URL rápida demora a propagar) e repita; depois `.\scripts\tunel.ps1 status`.

## Passo 2. Token de teste

- [ ] **2.1 Emitir.** `.\ssam server-token issue --customer "Prova ao vivo" --days 1 --lanes odc,o11`
  Esperado: o token `ssam_...` e a credencial `ssam_agent_...`, mostrados UMA vez. Guarde os dois no cofre.
  Se falhar: rode na raiz do clone, onde está `.local\server`.
- [ ] **2.2 Conferir.** `.\ssam server-token list`
  Esperado: o `tok_...` novo, faixas `odc,o11`, sem nenhum segredo na saída. Anote o `tok_...`.

## Passo 3. Pacote e instalação no cliente de teste

- [ ] **3.1 Pacote.** `.\scripts\agent-pack.ps1 -Out C:\t\prova\ssam-agent.zip -Lanes odc,o11 -NodeLicense C:\t\node-license\LICENSE`
  Esperado: "Pacote pack-...: ... (38 arquivos, faixas odc,o11)", sem aviso "Exceção conhecida" e sem "Varredura de PI falhou".
  Se falhar: a mensagem diz a entrada e a regra (`client-content`, `customer-pattern`, `kernel-text`); corrija a fonte, nunca a varredura.
- [ ] **3.2 Extrair.** `Expand-Archive C:\t\prova\ssam-agent.zip -DestinationPath C:\SSAM-Agent-Teste`
  Esperado: `agent\node\node.exe`, `agent\node\LICENSE`, `bin\o11\bridge\Anvil.Bridge.dll` (só ela e o `.deps.json`).
- [ ] **3.3 Configurar.**
  `C:\SSAM-Agent-Teste\agent\node\node.exe C:\SSAM-Agent-Teste\agent\ssam-agent.mjs setup --server https://<url> --root C:\SSAM-Agent-Teste --o11-port 4566`
  Cole a credencial `ssam_agent_...` quando pedir (ela não aparece).
  Esperado: "Agente configurado em C:\SSAM-Agent-Teste". `private\config.json` tem `"o11Port": 4566`.
  Se falhar: "pasta com espaço" ou "LOCALAPPDATA" → use outra pasta; "formato" → copie a credencial de novo.
- [ ] **3.4 Iniciar.** `powershell -ExecutionPolicy Bypass -File C:\SSAM-Agent-Teste\agent\ssam-agent.ps1 start`
  Esperado: "conectado" em até 30 s. Se falhar: leia `C:\SSAM-Agent-Teste\private\agent.log` (sem segredos).
- [ ] **3.5 Doctor.** `C:\SSAM-Agent-Teste\agent\node\node.exe C:\SSAM-Agent-Teste\agent\ssam-agent.mjs doctor --root C:\SSAM-Agent-Teste`
  Esperado: tudo ok (opções do Node, pacote íntegro, credencial, .NET 8 e 10, os dois Studios, servidor responde).

## Passo 4. Cliente MCP de teste

- [ ] **4.1 Configuração.** `.\scripts\tunel.ps1 config` e grave o JSON em `C:\t\prova\cliente\.mcp.json`.
- [ ] **4.2 Sessão.** Num terminal NOVO: `$env:SSAM_TOKEN = "<token ssam_...>"`, `cd C:\t\prova\cliente`, `claude`.
- [ ] **4.3 Doctor.** Peça: "chame ssam_doctor".
  Esperado: `agent.connected: true`, as faixas `odc` e `o11` compatíveis, as versões dos Studios iguais às do kernel.
  Se falhar: `AGENT_NOT_CONNECTED` → passo 3.4; `AGENT_PACK_MISMATCH` → pacote velho, refaça o 3.1.

## Passo 5. Attach real (prova 1)

- [ ] **5.1 ODC.** Abra o ODC Studio pelo atalho normal, entre no tenant de teste, abra o app de teste.
  Peça: `studio_attach {}` e depois `studio_status`.
  Esperado: `attached: true`; o status mostra o app aberto. Se falhar: `STUDIO_VERSION_MISMATCH` → versão; leia a resposta.
- [ ] **5.2 O11.** Abra o Service Studio pelo atalho NORMAL e abra o módulo de teste. Peça: `ssam_connect {lane:"o11"}`.
  Esperado: `connected: true`, `port: 4566`, `hook: "dev"`, `bridgeSha256` igual ao `o11Bridge.sha256` de
  `C:\SSAM-Agent-Teste\pack.json`. Prova que a fina carregou pelo `Anvil.RuntimeHook.Agent`, sem o kernel.
  Se falhar: `ATTACH_FAILED` "non-thin" → o Studio veio do atalho SSAM, reabra; `BRIDGE_VERSION_MISMATCH` → reinicie o
  Service Studio (a bridge carregada não é a do pacote); "Attach not confirmed" → não repita, reinicie o Studio.
- [ ] **5.3 Chave e ACL (parte da prova 2).** `icacls C:\SSAM-Agent-Teste\private\authority`
  Esperado: só o seu usuário, sem herança. `bridge.key` existe e nunca foi para o servidor.

## Passo 6. Os 21 verbos da fina (prova 2)

- [ ] **6.1 Leitura.** `node scripts\prova-verbos.mjs --root C:\SSAM-Agent-Teste --host <host O11 pessoal>`
  Esperado: uma linha por verbo; `loadErrors: []` e `transport: []`; `skipped` só `open_module`, `publish`, `close_module`.
  Recusa do próprio verbo conta como prova (`merge_from_oml` e `close_dialog` recusam de propósito).
  `refresh_references` (nona entrega) vai com uma chave de produtor que não existe: roda e não atualiza nada.
  `sc_web` e `sc_http` (24º) leem só o status pela sessão do Studio, sem abrir janela.
  Se falhar: `load-error` (TypeLoadException, MissingMethodException) → anote o verbo e a mensagem: é defeito da fina
  contra este Service Studio; pare a sessão O11.
- [ ] **6.2 Abrir e fechar.** `node scripts\prova-verbos.mjs --root C:\SSAM-Agent-Teste --host <host> --module <ModuloTeste>`
  Esperado: `open_module` e `close_module` ok. Salve o módulo antes (o fechar pode perguntar).
- [ ] **6.3 Publicar (opcional, com o OK do dono).** o mesmo comando com `--publish`.
  Esperado: `publish` ok e a publicação aparece no Service Center pessoal.

## Passo 7. OML nos dois sentidos, com sha256

- [ ] **7.1 Cliente → servidor (O11).** Peça: `o11_studio {command:"snapshot"}`.
  Esperado: um caminho `ws:o11/...` e o sha256. Confira: `Get-FileHash <arquivo em C:\SSAM-Agent-Teste\o11\...>` e
  `Get-FileHash <clone>\.local\server\customers\<tok>\...` dão o mesmo hash.
- [ ] **7.2 Cliente → servidor (ODC).** Peça: `studio_snapshot {module:"<AppTeste>"}`. Mesma conferência, com o `.json` ao lado.
- [ ] **7.3 Servidor → cliente (ODC).** Peça: `studio_open {module:"<AppTeste>", localOml:"<ws: da captura do 7.2>"}`.
  Esperado: a cópia em `C:\SSAM-Agent-Teste\odc\...` tem o mesmo sha256 do arquivo do servidor.
  Se falhar: `PATH_OUTSIDE_WORKSPACE` → use o caminho `ws:` que o servidor devolveu, nunca um caminho absoluto.

## Passo 8. Merge pela fina (prova 3)

- [ ] **8.1 Entrega.** Peça:
  `o11_deliver {module:"<ModuloTeste>", job:{expectValid:true, ops:[{op:"logic", data:{actions:[{name:"SsamProvaPing", public:true, outputs:[{name:"Result", type:"Integer"}], steps:[{assign:{Result:"1"}}]}]}}]}, checks:["SsamProvaPing"], authorize:"pode entregar o SsamProvaPing no <ModuloTeste>"}`
  Esperado: "entregue"; a action aparece no Studio; o módulo continua válido.
  Se falhar: `executed:false` "reference_plan" → o servidor é antigo; atualize-o antes.
- [ ] **8.2 Recibo repetido.** Peça a mesma entrega com o mesmo `operationId` da resposta (ou `merge_status`).
  Esperado: o mesmo recibo, sem segundo merge.
- [ ] **8.3 Desfazer.** No Studio, Ctrl+Z uma vez (ou duas, com ordem de merge).
  Esperado: a estrutura e o `ReferenceHash` voltam juntos.
- [ ] **8.4 Edição concorrente.** Capture, mude à mão no Studio a assinatura de uma referência de produtor e entregue.
  Esperado: `merged:false` "producer signature changed concurrently" antes do comando, ou `executed:false` dentro dele.
  Nada muda no módulo.
- [ ] **8.5 Refresh pela fina (nona entrega).** Peça: `o11_studio {command:"refresh-references", args:{module:"<ModuloTeste>"}}`.
  Esperado: `ok:true`, `refreshed`/`upToDate`; com mudança, um Ctrl+Z desfaz. Nada é publicado.
- [ ] **8.6 Validação assentada (nona entrega).** Na tarefa do 8.1 (`ssam_task {id}`, depois `ssam_evidence` no `task.json`):
  `validation.settled:true` e `validation.generation` maior que 0.

## Passo 9. Plano de assinaturas com produtor republicado (prova 4)

- [ ] **9.1** Republique de verdade um produtor do módulo de teste (mude uma action pública e publique).
- [ ] **9.2** Peça: `o11_environment {action:"refresh-refs", module:"<ModuloTeste>", authorize:"pode atualizar as referências do <ModuloTeste>"}`
  e depois uma entrega como a do 8.1.
  Esperado: `referenceSignatures` com o produtor, sem conflito; depois do merge o Studio mostra a referência atualizada.
- [ ] **9.3 Paridade.** Repita a mesma entrega no modo do dono (bridge completa, atalho SSAM, `ssam mcp`) num clone do módulo.
  Esperado: as mesmas mudanças em `referenceSignatures` (só a ordem dos conflitos pode diferir), inclusive `desired.IsValid`.

## Passo 10. find_element por captura (prova 5)

- [ ] **10.1** A entrega do 8.1 já roda a conferência `checks` no servidor, sobre uma captura.
  Esperado: `checks` com a action encontrada; nenhum `find_element` chegou à bridge.
- [ ] **10.2 Módulo grande.** Repita com o maior módulo de teste. Esperado: abaixo de 600 s. Anote o tempo.

## Passo 11. get_errors, publish e publish_log (prova 6)

- [ ] **11.1** Peça: `o11_studio {command:"errors"}`. Esperado: a lista de mensagens com `kernelHints:false`.
- [ ] **11.2** Publique o módulo de teste (passo 6.3) com um erro de propósito e peça `o11_studio {command:"publish-log"}`.
  Esperado: o erro com `element` vindo só de `ExtraInfo` (`Name;Key`) e a continuação de correção.

## Passo 12. environment_session no login SSO real (prova 7)

- [ ] **12.1 Leituras.** Peça: `o11_environment {action:"inventory"}` e `o11_environment {action:"download", module:"<ModuloTeste>"}`.
  Esperado: a lista e o OML baixado em `ws:o11/...` (espelho do `download`, com sha256).
- [ ] **12.2 Dados.** Peça uma leitura de entidade do módulo de teste com `o11_data`. Esperado: linhas; `(System)` e `Users` recusados.
- [ ] **12.3 Escrita só com o OK do dono.** Uma escrita de `o11_data` com palavras. Esperado: o registro muda.
- [ ] **12.4 Segredo ausente.** `Select-String -Path "$env:LOCALAPPDATA\Anvil\bridge-4566.log" -Pattern 'eyJ|Bearer|password'`
  Esperado: nada. Nenhuma resposta do MCP traz token, cookie ou senha.
- [ ] **12.5 Expiração.** Deixe a sessão parada 1 h e repita 12.1. Esperado: concessão nova, sem erro de lease velha.

## Passo 13. Diálogos e Service Center (prova 8)

- [ ] **13.1** Abra um diálogo no Studio (por exemplo Manage Dependencies) e peça `o11_studio {command:"windows"}` e
  `o11_studio {command:"dismiss-dialog", args:{title:"<título>"}}`. Esperado: o diálogo listado e fechado.
- [ ] **13.2** `o11_studio {command:"open-module", args:{name:"<ModuloTeste>"}}` com um diálogo de recuperação aberto.
  Esperado: a resposta descreve o diálogo; nada é clicado sem pedido.
- [ ] **13.3** Peça uma leitura do Service Center (`o11_service_center_read`) no host pessoal.
  Esperado: dados pela sessão do Studio; com a janela escondida e o login do cofre do cliente quando a página pede.
- [ ] **13.4** Guarda corporativa da fina: uma escrita de Service Center sem `corporateHosts` no `config.json` do cliente.
  Esperado: a fina pede `corporateInstruction` (conta todo host como corporativo); o servidor só a manda depois das
  palavras que nomeiam o ambiente.

## Passo 14. Controle Inteligente de Aplicativos (prova 9)

- [ ] **14.1** Numa máquina de cliente com o Controle Inteligente ligado (Segurança do Windows > Controle de aplicativos e
  navegador), repita os passos 3 e 5.2.
  Esperado hoje: a DLL não assinada pode ser bloqueada. Anote se o attach falhou e o evento em
  `Microsoft-Windows-CodeIntegrity/Operational`. Se bloquear: o próximo passo é assinar as DLLs do pacote.

## Passo 15. Revogar e ver a sessão fechar

- [ ] **15.1** `.\ssam server-token revoke --id tok_<id do passo 2>`
  Esperado: em até 2 s o agente para com código 2 (`ssam-agent.ps1 status`: parado, "revoked").
- [ ] **15.2** Peça qualquer ferramenta no cliente MCP. Esperado: 403; a sessão aberta foi fechada.
- [ ] **15.3** `C:\SSAM-Agent-Teste\agent\ssam-agent.ps1 start` de novo. Esperado: recusa com código 2 (credencial revogada).

## Passo 16. Encerrar

- [ ] `.\scripts\tunel.ps1 stop --server` (para o túnel e o servidor da 7310).
- [ ] Feche os Studios da prova. Apague `C:\SSAM-Agent-Teste` e `C:\t\prova`.
- [ ] Preencha a tabela abaixo e guarde as respostas em `docs\proofs\`.

## Variante: o gancho de release h1

Só quando a linha de release entregar o `Anvil.Hook.h1.dll` compilado numa staging tecida, com as raízes do publicador.

- [ ] `.\scripts\agent-pack.ps1 -Lanes odc,o11 -NodeLicense C:\t\node-license\LICENSE -Hook h1 -HookH1 <pasta do gancho> -Stage C:\t\prova\h1`
- [ ] No servidor MCP do publicador: `release_sign {releaseDir:"C:\\t\\prova\\h1", words:"<suas palavras>"}`.
- [ ] `.\scripts\agent-pack.ps1 -FromStage C:\t\prova\h1 -Out C:\t\prova\ssam-agent-h1.zip`
  Esperado: o ZIP com `release.json`, `release.sig.jws`, `studio\o11\hook\Anvil.Hook.h1.dll`, `studio\o11\bridge\b1\`.
- [ ] Opcional: `<clone>\.local\server\kernel.json` com `"o11Hook": "h1"` faz o servidor recusar pacotes sem o gancho de release.
- [ ] Repita os passos 3 a 6. Esperado no 5.2: `hook: "h1"`, `bridgeId: "b1"`, e
  `%USERPROFILE%\.ssam-hybrid\data\o11\runtime-connect\<pid>-<início>\receipt-b1.json` com `ok:true`.
  Se falhar: o recibo diz `manifest_mismatch:<arquivo>`, `manifest_unlisted:<arquivo>` ou `manifest_signature`.

## Resultado

| Prova (§8.8) | Passo | Resultado | Observação |
|---|---|---|---|
| 1 fina pelo gancho, porta ≠ 4516 | 5.2 | | |
| 2 os 21 verbos, chave e ACL | 5.3, 6 | | |
| 3 merge com `reference_plan`, Ctrl+Z, concorrência, recibo | 8 | | |
| 4 paridade do plano com produtor republicado | 9 | | |
| 5 `find_element` por captura, tempo | 10 | | |
| 6 `get_errors`, `publish`, `publish_log` | 11 | | |
| 7 `environment_session` no SSO real | 12 | | |
| 8 diálogos e Service Center | 13 | | |
| 9 Controle Inteligente de Aplicativos | 14 | | |
| túnel, token, revogação | 1, 2, 15 | | |
