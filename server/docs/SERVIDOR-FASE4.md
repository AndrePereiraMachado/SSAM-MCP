# Servidor hospedado: fase4 (pacote atritos 3)

A fase4 é a linha do servidor hospedado depois do pacote 3.
Ramo `servidor/fase4`, worktree `C:\Users\andre\SSAM-Hybrid-servidor-wt\fase4`.
A fase3 (`servidor/fase3`, worktree `...\fase3`) continua viva e intocada até o dono trocar.

Base: `distribuicao/main` (imagem Docker com os Studios, exemplos anonimizados, guarda da lista de nomes de clientes).
Produto: `pacote3/integracao` (`09ba8ba8`): 17º envio, bridge ODC `v45`, 78 ferramentas mais `ssam_friction`.

## 1. O que muda

### C12: o produto do pacote 3 no servidor

- Merge `c43fead7` (12 conflitos). Ficam as peças hospedadas da linha do servidor e o resto do produto.
- A bridge ODC `v45` não leva nenhum tipo do kernel: `SecurityWarningsCopy.cs` ao lado das cópias que já existiam.
  A varredura de propriedade intelectual do pacote do agente continua passando.
- `ssam_query_test` (novo) funciona hospedado na faixa ODC: a captura vai ao agente por sha256. Na faixa O11 responde
  `HOSTED_UNAVAILABLE` antes de mandar qualquer coisa (a bridge fina não tem teste de consulta).
- Nenhum nome de cliente entra na imagem (`hosted-image-denylist` verde).
- A bridge O11 fina (pacote do agente) acompanha a bridge completa do pacote 3: a cópia de `ScProtocol.cs` (com
  `ScWindowLifetime`, D5), os diálogos de todas as abas e janelas (`DialogScope`, publish parado por diálogo, segunda
  janela) e o verbo `answer_dependencies_dialog`. `DialogScope` lê os tipos de diálogo por `BridgeKit`, então a fina
  continua sem nenhum tipo do kernel. `query_test` fica só na bridge completa.

### C03: canal do agente e túnel

Agente 0.2.0:
- O envio de mensagens desiste em 10 s (mais 1 s a cada 64 KiB) e manda de novo.
- O pong vai num envio próprio. Um resultado preso nunca segura o pong.
- O stream sem cabeçalho de resposta em 15 s é refeito. Logo depois de um hello, o hello é refeito na hora, uma vez.

Servidor:
- Uma chamada escrita e não aceita em 15 s fecha o stream. O agente vivo reconecta na hora. A chamada é escrita de novo e
  ganha 60 s uma vez.
- O POST que saiu pelo canal anterior da mesma instância é aceito (antes dava 404 e um ciclo de reconexão).
- Uma chamada com o agente visto há menos de 5 min espera até 45 s pelo hello dele.
- Sem hello nesse tempo: `AGENT_RECONNECTING` com `retryAfterSeconds: 15` e a mesma chamada como continuação.
  Até 2,5 min sem contato, nada é pedido ao usuário. Depois, pede para conferir a janela do agente.
  Só depois de 5 min (ou com o agente parado de propósito) a resposta é `AGENT_NOT_CONNECTED` com "inicie o agente".
- O timer de morte do canal (45 s) fica acima do maior envio do agente (26 s).
- Logs novos em `server.log`: `agent-call` {kind, ms, ok, code}, `agent-call-unaccepted`, `agent-route-refused`,
  `agent-transfers-expired` (uma linha por varredura) e `mcp-response-flushed` {tools, bytes, ms} (quando a resposta de
  uma ferramenta saiu do servidor).
- O audit conta `ok:false` como falha, com o código.

### C26: o caminho do inbox é dito antes

- O hello do agente traz a pasta dele (`agent.root`). O `ssam_doctor` mostra `agent.inbox`.
- Um caminho absoluto dentro da pasta do agente vira o `agent:` dele (`C:\SSAM-Agent\inbox\job.json` vira
  `agent:inbox/job.json`).
- Qualquer outro caminho é recusado com `PATH_OUTSIDE_WORKSPACE`, o lugar exato (`<pasta>\inbox\<nome>`) e a mesma
  chamada com `agent:inbox/<nome>`.
- As instruções hospedadas dizem: job em arquivo no inbox (ferramenta Write, UTF-8), `AGENT_RECONNECTING` é repetir,
  protótipo aprovado vai 1:1 (op html mais o `<style>` no tema), nada está pronto sem o link do app, e subagente carrega
  as ferramentas SSAM por ToolSearch antes da primeira chamada.

### C32: doctor hospedado

- O `ok` olha só as faixas habilitadas para o token. Faixa desabilitada sai com `ok: null` (informação).
- Faixa ODC sem ODC Studio aberto: `ok: false`, código `DOCTOR_LANE_UNUSABLE` e continuação `ssam_connect {lane:"odc"}`
  ("abra o ODC Studio normalmente e chame ssam_connect").
- Agente reconectando: código `AGENT_RECONNECTING`.

### C04: retorno visual

- Tenant `<nome>.outsystems.dev` sem stage configurado: o link de Development é `https://<nome>-dev.outsystems.app`,
  marcado `source: "derived-stage"`. Antes era "No runtime origin" e nenhuma resposta tinha link.
- O tenant em que o ODC Studio do cliente está logado (ssam_connect, auth-status, cada captura) vai para o
  `tenants.json` do cliente com esse stage (`source: "derived"`). Um stage que já existe nunca é trocado.
- Toda entrega com op `html` ganha `preview.html` na pasta da evidência: o mesmo html que o kernel transformou em widgets,
  com o CSS do próprio job. Hospedado, o arquivo vai também para a pasta do agente e a resposta traz
  `preview.onUserMachine` (por exemplo `C:\SSAM-Agent\odc\lab\07-loja\preview.html`), para o usuário abrir no navegador.
  Com `until:"build"` dá para ver o preview antes do merge. É um preview estrutural: expressões aparecem como texto e o
  tema do OutSystems UI do app não é aplicado (a página diz isso).

### C14: espelho do túnel

- Com o agente 0.2.0, as entradas, o manifesto e o resto da pasta dele vão numa chamada só (`file.sync`), em vez de uma ida
  por arquivo. Um agente antigo continua com o caminho de antes.
- Um arquivo que o agente já tinha (resposta `skipped`) solta a transferência na hora (antes expirava em 10 min).
- Depois de um merge com sucesso, `after-merge.oml`, `match-tree.txt` e `second-pass-match-tree.txt` ficam no agente.
  Um merge que falhou traz tudo. Uma ferramenta que nomeia um deles (`ws:odc/lab/...`) traz o arquivo na hora.
- As pastas do agente voltam com até 4 `file.get` ao mesmo tempo.
- O agente lista os processos do Studio com `tasklist` e só descreve (PowerShell) um pid novo.

### Warm (aquecimento)

- Na partida do servidor hospedado (5 s depois): índices do discover das faixas, builder residente e worker ODC.
- Depois de cada entrega ou `studio_create_app` hospedados: builder e worker de novo, no máximo uma vez por minuto.
- Nunca compila nada. `SSAM_NO_WARM=1` desliga. O log mostra a linha `warm`.
- Para o worker ODC servir as entregas, o servidor sobe SEM `ANVIL_WORKER=0` e SEM `ANVIL_ODC_NO_WORKER`.

### Pool de build no servidor (faixa wp)

- Um pool só para o servidor inteiro (`SSAM_BUILD_WORKERS`, padrão `min(4, núcleos - 1)`).
- Justiça por cliente: o próximo slot vai para o cliente com menos builds rodando, depois para o atendido há mais tempo.
  Um cliente com dez builds na fila nunca segura o build único de outro.
- A pasta temporária de cada build fica no espaço do próprio cliente (`<ws>\odc\tmp\slot-<n>`).
- Duas entregas do mesmo cliente ao mesmo tempo nunca dividem a pasta de evidência (a segunda pega a próxima livre).
- Teste de carga offline (`fase4-wp-load.test.mjs`): 3 clientes x 3 entregas, cada comando de Studio pelo agente falso
  do cliente, build de 400 ms + builder de 100 ms + merge de 80 ms, 4 slots.
  Serial: 6,6 s. Paralelo: 1,6 s (4,1 vezes). No máximo 4 builds ao mesmo tempo. Merges de um mesmo Studio nunca se
  sobrepõem. O primeiro build de cada cliente começa antes do terceiro de qualquer outro.

## 2. Trocar o servidor vivo da fase3 para a fase4 (dono)

O servidor vivo usa `C:\Users\andre\SSAM-Hybrid-servidor-wt\fase3\.local\server` (tokens, espaços dos clientes, audit,
log) e escuta em `127.0.0.1:7310`. A fase4 usa a MESMA pasta de dados e a MESMA porta. Token, credencial do agente e
endereço público não mudam. O túnel não muda (ele aponta para a porta 7310).

1. Builds da fase4 (já feitos nesta entrega; refaça só se mudar código):
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\andre\SSAM-Hybrid-servidor-wt\fase4\scripts\setup-dev.ps1 -Yes -NoUserEnv -SkipInstall -SkipMcp -SkipDoctor
   ```
2. Avise o cliente (a sessão dele cai por alguns segundos). Pare a fase3:
   ```powershell
   C:\Users\andre\SSAM-Hybrid-servidor-wt\fase3\scripts\servidor.ps1 stop
   ```
3. Suba a fase4 com a pasta de dados da fase3, num PowerShell novo (sem `ANVIL_WORKER=0` nem `ANVIL_ODC_NO_WORKER`).
   `ANVIL_STUDIO_DIR` faz o kernel O11 do servidor ser o do Service Studio 11.55.91 instalado, o mesmo do pacote:
   ```powershell
   $env:SSAM_SERVER_DIR = 'C:\Users\andre\SSAM-Hybrid-servidor-wt\fase3\.local\server'
   $env:ANVIL_STUDIO_DIR = 'C:\Program Files\OutSystems\Service Studio 11\Service Studio'
   C:\Users\andre\SSAM-Hybrid-servidor-wt\fase4\scripts\servidor.ps1 start -Port 7310
   C:\Users\andre\SSAM-Hybrid-servidor-wt\fase4\scripts\servidor.ps1 status
   ```
4. Confira em `...\fase3\.local\server\server.log`: `listening` na porta 7310 e, uns segundos depois, a linha `warm`
   (`delivery.worker.ok` e `delivery.builder.ok`).
5. Mande o pacote novo ao cliente (seção 3). Até ele atualizar, as ferramentas da faixa ODC respondem
   `AGENT_PACK_MISMATCH` (o pacote dele leva outra bridge ODC); as ferramentas só do servidor continuam funcionando.
6. Na primeira sessão do cliente: `ssam_doctor` deve mostrar `agent.agentVersion: "0.2.0"`, `agent.inbox`,
   `lanes.odc.ok: true` e `lanes.o11.ok: null` (token só ODC).

Para voltar à fase3: pare a fase4 (mesmo `$env:SSAM_SERVER_DIR`, `...\fase4\scripts\servidor.ps1 stop`), suba a fase3
(`...\fase3\scripts\servidor.ps1 start -Port 7310`) e devolva ao cliente o pacote anterior. O agente 0.2.0 também
conversa com a fase3, mas a bridge ODC do pacote novo (`v45`) não é a da fase3.

## 3. Pacote novo do agente (dono)

- Pacote: `C:\t\pa3-server\pack\ssam-agent.zip`, id `pack-20261008-100429`, 38 arquivos, sha256 do ZIP
  `6EE00C4BA7AF14794D3E3B6EA56D6CDD2A0A71CCBC406B99444E7DB26A1924BC`. Faixas odc e o11, gancho O11 de desenvolvimento, bridge O11
  fina feita para o Service Studio 11.55.91, Node do pacote com a licença, bridge ODC `v45`, agente 0.2.0. O `pack.json`
  dentro do ZIP tem o sha256 de cada arquivo.
- Gerado por `scripts\agent-pack.ps1 -Out C:\t\pa3-server\pack\ssam-agent.zip -NodeLicense C:\t\node-license\LICENSE`
  com `ANVIL_STUDIO_DIR` no Service Studio instalado, e conferido pela varredura de propriedade intelectual (sem achados).
  Para gerar de novo, use os mesmos parâmetros.
- Envie o ZIP por um canal privado. Token e credencial NÃO mudam e não vão junto.
- Mande ao cliente a seção "Atualizar o agente (pacote novo)" de `docs\AGENTE-CLIENTE.md`.

## 4. O que o cliente faz

1. `C:\SSAM-Agent\agent\ssam-agent.ps1 stop` e feche o ODC Studio.
2. `Expand-Archive .\ssam-agent.zip -DestinationPath C:\SSAM-Agent -Force` (por cima da mesma pasta; configuração,
   credencial e dados ficam).
3. `C:\SSAM-Agent\agent\ssam-agent.ps1 start` e `node C:\SSAM-Agent\agent\ssam-agent.mjs doctor`.
4. Abra o ODC Studio, chame `ssam_doctor` no cliente MCP e depois `studio_attach`.
5. Não rode o `setup` de novo e não mexa no `.mcp.json`: endereço e token são os mesmos.

## 5. Testes desta entrega

- Linha do servidor: `agent/tests` (inclui `fase4.test.mjs`), `agent-hub.test.mjs`, `hosted-*.test.mjs`,
  `http-server.test.mjs`, `fase4-server.test.mjs`, `fase4-wp-load.test.mjs`, `public-signature-drift.test.mjs`,
  `hosted-image-denylist.test.mjs`: verdes.
- Fachada dirigida: `executor`, `seam-guard`, `app-urls`, `pa3-*`, `kernel-delivery*`, `studio-create-app`,
  `studio-connect`, `lanes`, `build-pool*`, `pacote-laneE-responses`: verdes.
- `Bridge.Tests` 149/149, `Builder.Tests` 7/7 (o builder na fixture anonimizada) e `Anvil.Bridge.Thin.Tests` 110/110
  (antes desta entrega a fina não compilava com o pacote 3).
- A suíte JS inteira: as únicas falhas são as que dependem dos carimbos e da pasta `test-work` da bateria completa do
  kernel (catálogo e discover `proven-current`) e as ambientais de sempre (ACL do DPAPI, git fora do PATH).

## 6. Fora desta entrega

- C04 com o tema real do app: o preview usa o CSS do job, não o CSS do OutSystems UI nem o do tema já publicado.
- C14 no espelho O11 (`o11-stage.mjs`): continua um arquivo por ida (o cliente atual é só ODC).
- C25 parte do servidor (resposta do `create_app` desacoplada do canal) e C39 (`DUPLICATE_MCP_ENTRY`): não feitos.
- Prova ao vivo: só com o dono (troca da seção 2 e uma entrega real medida).
