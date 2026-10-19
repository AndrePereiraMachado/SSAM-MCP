# Fase 2 da distribuição: o agente no cliente (desenho)

Este documento é o contrato das faixas paralelas da fase 2. Ele parte do código de `servidor/fase2` (commit base
`49e91562`: fase 1 + `consolidacao/main` `63137c28`). Cada afirmação sobre o código atual foi conferida nos arquivos
citados. Nenhuma faixa edita este documento: um desvio necessário vai na resposta final da faixa, para o orquestrador.

**Revisão 1 (2026-10-04).** Aplica a crítica do desenho `4aaf4b95`: as 12 correções obrigatórias e as 20 recomendadas,
todas conferidas no código. A seção 13 liga cada item à seção onde ele entrou. As faixas passam de cinco para quatro: a
faixa `exec` foi fundida na `policy`, que passa a se chamar `hosted` (seção 10).

## 0. Decisões em uma página

- O cliente usa o PRÓPRIO cliente MCP (Claude Code ou outro) com URL + token. O LLM roda na conta do cliente.
  **Nenhum LLM roda no servidor.** O SSAM não tem LLM dentro, e a fase 2 não acrescenta nenhum.
- O servidor guarda tudo o que é do dono: kernel, catálogo, discover, regras, receitas, builder e leitor. Um agente fino
  na máquina do cliente faz só o que precisa tocar aquela máquina: falar com as bridges dos Studios, listar processos
  do Studio, ler e gravar arquivos dentro do próprio workspace, anexar a bridge no Studio do cliente.
- Toda chamada à sessão do Studio (Portal/tenant ODC, Service Center e ambiente O11) roda DENTRO do Studio do cliente,
  pela bridge, via agente. O cofre, o API Client e a janela de prompt do dono nunca são usados no modo hospedado.
- Canal do agente: HTTP comum no MESMO servidor (`/agent/v1/*`). Descida por um GET de longa duração em NDJSON,
  subida por POST, arquivos em partes de 4 MiB com sha256. Só módulos internos do Node 24. Nenhuma dependência nova.
- Credencial do agente própria (`ssam_agent_...`), emitida junto com o token MCP e presa ao MESMO registro do
  `tokens.json`. Revogar o token derruba as sessões MCP e o canal do agente em até 1 s; trocar a credencial do agente
  fecha o canal atual em até 1 s. O servidor nunca escreve `tokens.json`.
- Uma costura única na fachada: `executor.call(kind, params)`. `LocalExecutor` é o comportamento de hoje e é o padrão
  SÓ em stdio e no CLI. No `ssam serve` o padrão do processo é o `DenyExecutor`: código que perder o contexto falha
  fechado (`HOSTED_CONTEXT_LOST`) e nunca toca o Studio do dono. `AgentExecutor` encaminha ao agente, que aceita só os
  9 tipos da lista fechada; o servidor nunca manda código.
- `ssam serve` é hospedado por padrão. Servir os Studios do PRÓPRIO dono (o comportamento da fase 1) exige
  `--local-studios`, que só escuta em loopback e recusa `--public-host`, `--allow-remote` e pedidos vindos de proxy.
- Cada cliente tem um workspace no servidor (`.local/server/customers/<tokenId>/`). Os arquivos do agente espelham
  `odc/`, `o11/` e `inbox/` desse workspace com o mesmo caminho relativo. O LLM vê e passa caminhos `ws:<relativo>`.
  Todo caminho que vem do agente passa por `fromAgent` (6.2): um agente modificado não lê nem escreve fora do
  workspace do próprio cliente.
- O CLI O11 do servidor fala com o Studio do cliente por um relay por cliente, com chave própria por token. Sem
  conexão O11 do cliente nada O11 roda (`O11_NOT_CONNECTED`); o CLI hospedado nunca herda porta, chave nem pasta de
  autoridade do dono.
- O servidor recusa com texto claro quando a versão do Studio do cliente (instalado e processo escolhido) não bate com
  a do kernel que ele tem.
- Quatro faixas com donos de arquivo exclusivos: `hub`, `agent`, `seam`, `hosted` (seção 10).

## 1. O que roda onde

| Peça | Onde roda | Observação |
|---|---|---|
| LLM do cliente (Claude, outro) | conta/máquina do cliente | chama as ferramentas MCP por HTTPS com `Authorization: Bearer ssam_...` |
| Servidor MCP (`ssam serve`), uma instância `createSsamServer` por sessão | máquina do dono | escuta em `127.0.0.1`; HTTPS por túnel ou proxy (seção 9) |
| Kernel O11 (`anvil.dll`), kernel ODC (`anvil-odc.dll`), builder ODC, leitores residentes, catálogo, discover, receitas | máquina do dono | usam as DLLs do Studio INSTALADO no servidor (Service Studio 11.55.92, ODC Studio 1.7.28) |
| Hub do agente (`/agent/v1/*`) | máquina do dono, dentro do mesmo processo HTTP | `agent-hub.mjs` (faixa `hub`) |
| `AgentExecutor`, espelho de arquivos, relay do bridge O11, portão hospedado | máquina do dono | `hosted/*.mjs` (faixa `hosted`) |
| Agente SSAM (`agent/ssam-agent.mjs`) | máquina do cliente | conexão só de SAÍDA; nenhuma porta aberta no cliente |
| Bridge ODC (`ODC3.Bridge.v35.dll`) e cliente de attach (`ODC3.Bridge.Client.dll`) | dentro do ODC Studio do cliente / máquina do cliente | vêm no pacote do agente |
| Bridge O11 fina (`Anvil.Bridge.dll`, sem `Anvil.Core.dll`), `Anvil.RuntimeHook`, `Anvil.Connect` | dentro do Service Studio do cliente / máquina do cliente | vêm no pacote; desde a fase 3 a bridge é a fina, sem o kernel ([O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md)) |
| Sessões dos Studios (login, SSO, tokens, cookies) | dentro dos Studios do cliente | nunca saem do processo do Studio; o servidor recebe só o resultado de cada passo |
| OMLs | trafegam servidor ↔ agente por blobs com sha256 | nunca passam pelo LLM |

**Nenhum LLM roda no servidor.** O servidor não chama API de modelo, não guarda chave de modelo e não decide nada por
um modelo. O LLM do cliente roda na conta do cliente e paga a conta do cliente. Esta fase não muda isso.

## 2. Canal do agente

### 2.1 Escolha do transporte

Escolhido: **HTTP de longa duração no próprio `http-server.mjs`**.

- Descida (servidor → agente): `GET /agent/v1/stream` devolve `200 application/x-ndjson`; o servidor escreve uma
  mensagem JSON por linha e dá `flush`. Cabeçalhos `cache-control: no-store`, `x-accel-buffering: no`.
- Subida (agente → servidor): `POST /agent/v1/messages` com um lote JSON.
- Arquivos: `PUT`/`GET /agent/v1/blobs/<transfer>/<index>` com o corpo binário de uma parte.

Por quê:

- Node 24 tem cliente WebSocket embutido, mas não tem servidor WebSocket. Um servidor WebSocket exigiria a
  dependência `ws` ou escrever a moldura RFC 6455 à mão. O HTTP usa o que já existe (`node:http` no servidor, `fetch`
  no agente).
- Reaproveita a autenticação, a verificação de Host/Origin, o limite por token e a auditoria do servidor da fase 1.
- Passa por qualquer túnel ou proxy HTTPS (Cloudflare Tunnel, Caddy) sem configurar `upgrade`.
- Os limites de corpo dos túneis (Cloudflare: 100 MB por pedido) não afetam: cada parte tem no máximo 4 MiB.

### 2.2 Credencial do agente

- Formato: `ssam_agent_` + 32 bytes aleatórios em base64url (43 caracteres). Mostrada UMA vez.
- Fica no MESMO registro do token MCP em `tokens.json`: campos novos opcionais `agentSha256`, `agentIssuedAt`, `lanes`.
  O schema continua `ssam-server-tokens/1` (campos novos são opcionais; registros da fase 1 continuam válidos).
- O token MCP vai para a configuração do cliente MCP. A credencial do agente vai para o arquivo do agente. Uma não serve
  no lugar da outra: `/mcp` só aceita `ssam_` sem o prefixo `ssam_agent_`, e `/agent/v1/*` só aceita `ssam_agent_`.
- `revoke --id` invalida as duas. `agent-rotate --id` troca só a do agente.
- O canal guarda o `agentSha256` com que se autenticou. A varredura de 500 ms (2.7) fecha o canal cujo registro passou a
  ter outro `agentSha256` com `Close {reason:"rotated"}`; o agente sai (código 2) e espera a nova credencial (`setup`).
- **O servidor nunca escreve `tokens.json`.** Só o CLI de administração escreve (`server-tokens.mjs save`, que lê,
  modifica e grava, linhas 35-41); uma escrita do servidor concorrendo com um `revoke` podia ressuscitar um token
  revogado. Por isso `lastSeenAt` fica só em memória (`AgentLink.info()`), e `list` não o mostra.
- Comparação em tempo constante, como `verify` de hoje (`store.verifyAgent(presented)`).

### 2.3 Rotas

Todas exigem `Authorization: Bearer ssam_agent_...`. Sem credencial ou desconhecida: 401. Revogada ou vencida: 403.

| Método e rota | Corpo | Respostas |
|---|---|---|
| `POST /agent/v1/hello` | `Hello` (≤ 1 MiB) | 200 `Welcome`; 401; 403; 409 `AGENT_PROTOCOL_UNSUPPORTED`; 413; 429 |
| `GET /agent/v1/stream?channel=<id>` | — | 200 NDJSON (`Call`, `Ping`, `Close`); 404 `CHANNEL_UNKNOWN` (canal de outro token, substituído ou fechado) |
| `POST /agent/v1/messages?channel=<id>` | `{ "messages": [Accepted \| Result \| Pong] }` (≤ 1 MiB) | 204; 404; 413 `MESSAGE_TOO_LARGE` |
| `PUT /agent/v1/blobs/<transfer>/<index>?channel=<id>` | bytes da parte (≤ `partBytes`) | 204; 400 `PART_HASH_MISMATCH` / `TRANSFER_INVALID`; 409 `TRANSFER_CONFLICT`; 413 |
| `GET /agent/v1/blobs/<transfer>/<index>?channel=<id>` | — | 200 bytes + `x-ssam-part-sha256`; 400 `TRANSFER_INVALID`; 404 |
| `DELETE /agent/v1/channel?channel=<id>` | — | 204 (desligamento limpo) |

- Antes de tocar o disco, o hub confere os segmentos CRUS da URL, sem `decodeURIComponent`: `channel` e `transfer` =
  `^[0-9a-f]{32}$`; `index` = inteiro decimal sem zero à esquerda (`^(0|[1-9][0-9]{0,5})$`) e menor que `parts` da
  transferência. Fora disso: 404 `CHANNEL_UNKNOWN` (canal) ou 400 `TRANSFER_INVALID`, sem nenhum acesso a arquivo.
- As chamadas pendentes ficam num mapa POR TOKEN, nunca num mapa global por id. `accepted` ou `result` com um id que não
  está pendente no token que apresentou a credencial é ignorado e registrado no log (`event:"agent-unknown-id"`), com
  resposta 204 normal.
- No máximo 32 chamadas pendentes por token: a 33ª falha na hora com `AGENT_BUSY` (`executed:false`).
- As rotas do agente têm limite próprio por token (padrão 3000 pedidos por minuto, 429 com `Retry-After`). Não gastam
  o limite de 240/min do `/mcp`.
- `transfer` é um id aleatório de 128 bits em hexadecimal (32 caracteres), escolhido por quem envia o arquivo.

### 2.4 Vínculo: um agente por cliente

- O vínculo é por token (`tokenId`): no máximo UM canal de agente vivo por token.
- Todas as sessões MCP daquele token (até 8, como na fase 1) usam esse agente. Sessões de outro token nunca o alcançam.
- `Hello.instance` é um UUID gerado a cada início do processo do agente.
  - Mesmo `instance` de um canal anterior: **retomada**. As chamadas pendentes continuam. São reescritas no stream novo
    SÓ as que nunca receberam `accepted`; uma chamada aceita espera o `result`, que o agente reenvia da caixa de saída
    (3.4).
  - `instance` diferente: **substituição**. O stream antigo recebe `Close {reason:"replaced"}` e fecha; as chamadas
    pendentes da instância antiga falham com `AGENT_DISCONNECTED` (resultado incerto quando já tinham sido entregues).
    O agente substituído NÃO reconecta sozinho (sai com código 3), o que evita dois agentes brigando pelo mesmo token.

### 2.5 Batimento, reconexão e prazos

- O servidor manda `Ping` a cada `heartbeatMs` = 15000. O agente responde `Pong`.
- O servidor considera o canal morto sem nenhum POST do agente por `deadAfterMs` = 45000: fecha o stream. As chamadas
  pendentes esperam uma retomada até o próprio prazo.
- O agente considera o canal morto sem nenhuma linha (nem `Ping`) por 45000 ms: aborta o `fetch` e reconecta.
- Reconexão do agente: 1, 2, 4, 8, 16, 30 s (teto), com variação de ±20%. Volta a 1 s depois de 60 s de canal estável.
  Para de vez em 401, 403, 409 e em `Close` com `revoked`, `expired`, `replaced` ou `rotated`. `protocol-error` e
  `server-stop` reconectam com o mesmo recuo.
- Prazo de cada chamada (`Call.deadline`, epoch ms) = agora + prazo do tipo (tabela da seção 4.4). O agente aplica o
  próprio timeout de operação, igual ao local; o prazo do servidor é a rede de segurança.
- Nada é cancelado: uma operação nativa não tem cancelamento (mesma regra de hoje). Prazo vencido depois da entrega é
  resultado incerto.

### 2.6 Tamanhos e arquivos

| Limite | Valor |
|---|---|
| Linha do stream e corpo de POST | `maxMessageBytes` = 1 048 576 |
| Mensagem com valor inline | `inlineMaxBytes` = 524 288, medido como `Buffer.byteLength(JSON.stringify(mensagem))` da mensagem `call` ou `result` INTEIRA; acima disso o valor vai como blob (`paramsBlob` / `valueBlob`) |
| Parte de blob | `partBytes` = 4 194 304 |
| Arquivo | `maxFileBytes` = 536 870 912 |
| Valor de resultado (`valueBlob`) | `maxValueBytes` = 16 777 216: o servidor monta o valor na memória, então o teto fica muito abaixo do de arquivo (que vai parte a parte para o disco). Acima disso, `VALUE_TOO_LARGE`: o agente nem sobe; o servidor recusa antes de ler qualquer parte. Um resultado maior viaja como arquivo |
| Transferências simultâneas por token | 4 (um resultado que chega depois do prazo libera na hora as subidas que nomeia) |
| Chamadas pendentes por token | 32 (`AGENT_BUSY`) |
| Transferência ociosa | expira em 10 min (partes apagadas) |
| Cota do workspace por cliente | 5 GiB (`WORKSPACE_FULL`, seção 6.1) |

Medir a mensagem serializada, e não o valor, cobre o JSON escapado dentro de JSON (`{line}` do `odc.pipe`) e o texto não
ASCII: medido pelo valor, um resultado já entregue podia passar de 1 MiB, levar 413 e virar incerto.

Transferência (`BlobRef = {transfer, sha256, size, parts, partBytes}`):

- Agente → servidor (resultado de `file.get` ou valor grande): o agente calcula sha256 e tamanho, envia as partes em
  ordem com `PUT` e os cabeçalhos `x-ssam-part-sha256`, `x-ssam-total-sha256`, `x-ssam-total-size`, `x-ssam-parts`,
  e só então manda o `Result` com o `BlobRef`. O servidor confere cada parte ao receber e o total ao montar. Divergência:
  `BLOB_HASH_MISMATCH`, nada é gravado. O destino da montagem é sempre um caminho já confinado por `fromAgent` (6.2).
- Servidor → agente (`file.put` ou parâmetros grandes): o servidor registra a transferência e manda o `Call` com o
  `BlobRef`. O agente baixa as partes com `GET`, confere cada uma e o total, grava num `.part` temporário e renomeia.
- Uma parte que falha é pedida de novo até 3 vezes. As partes são sequenciais (simples e suficiente). Cada pedido de
  parte tem prazo próprio e a nova tentativa de uma parte sem resposta vai numa conexão nova (2.9).
- As partes recebidas ficam em `customers/<tokenId>/state/transfers/<transfer>/` e são apagadas ao montar ou expirar.

### 2.7 Revogação e troca de credencial

- O hub varre a cada 500 ms (o mesmo `sweepMs` das sessões): token não ativo → `Close {reason:"revoked"|"expired"}`,
  fim do stream, chamadas pendentes rejeitadas com `AGENT_REVOKED`, transferências apagadas. `agentSha256` do registro
  diferente do que o canal autenticou → `Close {reason:"rotated"}` e as pendentes falham com `AGENT_DISCONNECTED`.
- Todo pedido do agente confere a credencial: depois da revogação recebe 403 e o agente sai (código 2).
- As sessões MCP do token já são fechadas pela varredura da fase 1. Meta medida em teste: tudo fechado em ≤ 1 s.

### 2.8 Isolamento entre clientes

- Tudo é indexado pelo `tokenId` que a credencial prova: canal, chamadas pendentes, transferências, workspace,
  executor e relay. Nenhuma rota aceita um id de cliente vindo do agente.
- Canal ou transferência de outro token: 404, igual a um que nunca existiu.
- O relay O11 de um cliente só encaminha para o agente daquele cliente e só aceita a chave do relay DAQUELE cliente
  (`<ws>/state/relay-authority/bridge.key`, aleatória por contexto). Nunca aceita a chave do controlador do servidor,
  que é a chave em que o Service Studio do próprio dono confia (4.6).
- Caminhos que vêm do agente passam por `fromAgent` (6.2): nenhum alcança `state/`, `.local/server/tokens.json` ou o
  workspace de outro cliente.
- O workspace de um cliente não aparece para outro: `ssam_evidence` e o confinamento de caminhos só enxergam o próprio,
  e dentro dele só `odc/`, `o11/` e `inbox/`.

### 2.9 Rede do agente (fase4-24)

Teste em produção de 2026-10-11: duas partes pequenas de resultado (60 KB e 75 KB, uma parte cada) levaram 26,8 s e
48,3 s; um minuto depois, os mesmos tamanhos levaram 0,2 s. O IP público do dono mudou no meio do teste (NAT de
operadora): a conexão TCP aberta vira um buraco negro (nada volta, nem reset) e o pedido esperava o sistema desistir
(cerca de 20 a 30 s por conexão), porque o PUT de uma parte só desistia em 120 s.

O agente 0.2.1 (`agent/lib/net.mjs`, `blobs.mjs`, `channel.mjs`):

- Prazo por parte: `partTimeoutMs` = 10 s + 1 s por 64 KiB da parte (a mesma regra dos POSTs de mensagens do C03; uma
  parte de 60 KB: 11 s; uma de 4 MiB: 74 s). O prazo cobre a resposta e o corpo dela, na subida e na descida.
- Parte sem resposta (prazo vencido, conexão perdida) é pedida de novo numa conexão só dela, aberta para o pedido e
  fechada depois, nunca na conexão do pool que travou; recuo de 250, 500 e 750 ms. Uma parte que voltou com status
  (400, 5xx) continua no pool. Parte repetida não duplica: o servidor guarda a parte que já tem com o mesmo sha256 e
  responde 204 de novo (`putPart`). As conferências de sha256 da parte e do arquivo não mudaram.
- As conexões saem de `node:http`/`node:https`, com regras que o `fetch` embutido não deixa definir: conexão do pool
  ociosa por mais de 2 s é fechada e nunca reaproveitada (o Node do servidor fecha as dele em 5 s e o Caddy não anuncia
  prazo); sondas TCP keep-alive depois de 5 s sem tráfego em toda conexão (Windows: 10 sondas a 1 s), então um stream
  morto cai em cerca de 15 s em vez de esperar o timer de 45 s; um pedido que falha fecha as outras conexões ociosas do
  pool (podem estar no mesmo caminho morto).
- O `hello` desiste em 15 s, como os cabeçalhos do stream (antes, 120 s). As mensagens continuam com 10 s + 1 s por
  64 KiB e o pong no seu próprio POST. O recuo de reconexão e o timer de 45 s não mudaram.
- Proxy: o mesmo do `fetch`. Com `--use-env-proxy` (`ssam-agent.ps1`) o Node dá aos agentes globais o `HTTPS_PROXY` e
  o `NO_PROXY` do ambiente, e o `net.mjs` usa esse mesmo `proxyEnv`. Redirecionamento não é seguido (o servidor é https
  e não redireciona `/agent/v1`).
- Volta ao `fetch` embutido, se for preciso: `SSAM_AGENT_HTTP=fetch` no ambiente do agente (os prazos por parte ficam;
  as regras de conexão, não).
- Diário do agente: cada nova tentativa de parte grava `blob-retry` (`direction`, `index`, `attempt`, `reason`, `ms`,
  `fresh`).
- Testes: `agent/tests/net.test.mjs` (um relé TCP que vira buraco negro: a parte termina perto do prazo numa conexão
  nova, sem parte duplicada no servidor).

### 2.10 Teste de rede e jobs inline (fase4-24, velocidade hospedada)

Análise do teste de produção de 2026-10-11 (`C:\t\lentidao\ANALISE.md`, 2.4 e 2.5): a rede do dono usava duas saídas
públicas ao mesmo tempo, por conexão. Numa delas, pedidos pequenos passavam e corpos de 60 a 75 KB andavam a ~2,3 KB/s.
Duas subidas travadas custaram 75 s; uma delas era o job, que só subiu pelo agente porque as instruções mandavam gravá-lo
no inbox.

Jobs inline:

- `HOSTED_RULES` (`platforms/odc/facade/ssam.mjs`): o modelo manda o próprio job no argumento `job`, em JSON compacto,
  qualquer que seja o tamanho. O pedido MCP vai direto ao servidor (até 16 MiB, `http-server.mjs`; o Caddy corta em
  20 MB). Nada passa pelo agente. `agent:inbox/<arquivo>` fica para arquivos do usuário (OML, imagens, assets); um job
  que já está no inbox ainda funciona.
- O texto JSON de um job (`"{...}"` ou `"[...]"`) é o próprio job, mas só nos ponteiros de job (`/job` das quatro
  ferramentas de job e a `query` do `check-job`; `hosted/job-paths.mjs` `jobTextPointers`): o portão o converte no objeto
  antes de tudo (`parseJobTexts`) e confere os caminhos de dentro dele como os de um objeto (regra 5 de 6.3). Um texto
  ali que parece JSON e não é recebe `JOB_INVALID`. Em qualquer outro ponteiro, um valor que começa com `{` ou `[` é um
  caminho como outro qualquer (antes ficava isento em todos, e `ssam_evidence {file:"[x]/../../<arquivo do servidor>"}`
  chegava ao handler sem resolver). Antes desta regra o texto virava `ws:<faixa>/{"ops":...}` e a ferramenta não achava o arquivo. O proxy do
  `studio_deliver` lê esse texto como o job (antes ia ao servidor ODC como caminho). O `o11_deliver` já lia
  (`job-patch.mjs plainJob`).
- `PATH_OUTSIDE_WORKSPACE` de um job (`agent-paths.mjs`): a correção é o job inline na mesma chamada (o marcador
  `INLINE_JOB_MARKER` na continuação); outros arquivos continuam indo para o inbox.
- `base_drift` de um `studio_deliver` com job inline: a continuação nomeia o arquivo que o proxy gravou
  (`nextBasedOn.job`) em vez de devolver o job inteiro.

Teste de rede (`ssam_doctor {network:true}`, só no hospedado, uns 5 s):

- Tipo de chamada `net.probe` (`agent/lib/net-probe.mjs`; a lista fechada de `kinds.mjs` ganhou o tipo em
  `servidor/fase4-24`, junto das listas do 24º, no agente 0.3.1). `params` `{probes?: [{bytes, count}], budgetMs?}`; padrão: 8 subidas de 1 KiB e depois
  2 de 1 MiB, em 4,5 s. Cada subida vai numa conexão só dela (`net.mjs` `fresh`), então pode sair por outra saída da
  internet. Um grupo que não é o último usa no máximo 40% do prazo. Os bytes são aleatórios; nada da máquina é lido ou
  gravado. Limites: 24 subidas, 2 MiB cada, 8 MiB no total, prazo de 0,5 a 15 s.
- Rota `PUT /agent/v1/probe/<id>?channel=<canal>` (`agent-hub.mjs probeUpload`): conta e descarta o corpo (até
  `probeMaxBytes` = 2 MiB, acima disso 413), responde `{ok, bytes, ms, via}` e guarda na memória, por token (no máximo
  64), de onde veio (`via`: o primeiro salto de X-Forwarded-For, sem o último número do IPv4, ou o /48 do IPv6), quanto
  chegou e quando. O hub só manda `net.probe` a um agente cujo Hello lista o tipo (`link.supports`).
- `hosted/network-check.mjs` junta o que o agente mediu com o que o hub viu e classifica cada subida: `ok`, `slow`,
  `stalled` (chegou ao servidor e andou a menos de 32 KiB/s ou parou) ou `unreached` (a conexão nova nunca chegou).
  Por saída: `boa`, `lenta` ou `perde`. Veredito em palavras simples: `ok`, `slow`, `one-exit-lossy` ("one of your
  internet exits (177.26.87.x) loses packets on uploads..."), `uploads-lossy` e `new-connections-fail` (um quarto
  ou mais das conexões novas não chegou: o caso do 5G ancorado da nota da integradora). As mensagens são em inglês
  desde `server/english-agent` (16/10/2026). Os valores `boa`/`lenta`/`perde` e a saída `desconhecida` continuam como
  estão até o dono decidir.
- Sem `network:true`, o hub mede cada parte de arquivo que sobe (`noteUpload`): uma parte acima de 3 s + 1 s por 128 KiB
  é lenta (log `agent-upload-slow`). Com partes lentas nos últimos 30 min, o doctor mostra `agent.uploads` e
  `network: {ran:false, code:"UPLOADS_SLOW", continuation: ssam_doctor {network:true}}`. O `ok` do doctor não muda.
- Agente sem o tipo: `network: {ran:false, code:"AGENT_KIND_MISSING"}` com a versão do agente. Fora do hospedado:
  `NOT_HOSTED`.
- Testes: `agent/tests/net-probe.test.mjs` (o tipo sozinho) e
  `platforms/odc/facade/tests/hosted-network.test.mjs` (rota do hub, classificação, um relé com duas saídas em que a
  segunda trava corpos grandes, o doctor) e `hosted-inline-job.test.mjs` (job inline grande pelo servidor hospedado,
  sem subida pelo agente).

## 3. Protocolo do canal (`ssam-agent/1`)

Campos em inglês, como o resto do código. `?` = opcional.

### 3.1 `Hello` (agente → servidor, corpo de `POST /agent/v1/hello`)

```
{ t: "hello", protocol: "ssam-agent/1", instance: <uuid>,
  agent: { version: <string>, node: <string>, platform: "win32", startedAt: <ISO> },
  pack: { id: <string>, lanes: ["odc"|"o11", ...], odcBridge: "v35"|null, o11BuiltFor: "11.55.91"|null },
  studios: { odc: { installed: {dir, version}|null }, o11: { installed: {dir, version}|null } },
  o11Connection: { pid, startedUtc, port, studioVersion } | null }
```

Exemplo:

```json
{"t":"hello","protocol":"ssam-agent/1","instance":"6f1c0e1e-3a59-4c43-9d8b-2f7b6f0d9a11",
 "agent":{"version":"0.1.0","node":"v24.19.0","platform":"win32","startedAt":"2026-10-04T18:00:00.000Z"},
 "pack":{"id":"pack-20261004-1","lanes":["odc","o11"],"odcBridge":"v35","o11BuiltFor":"11.55.91"},
 "studios":{"odc":{"installed":{"dir":"C:\\Program Files\\OutSystems\\ODC Studio\\ODC Studio","version":"1.7.28.4021"}},
            "o11":{"installed":{"dir":"C:\\Program Files\\OutSystems\\Service Studio 11\\Service Studio","version":"11.55.91.65012"}}},
 "o11Connection":null}
```

### 3.2 `Welcome` (resposta 200 do hello)

```
{ t: "welcome", channel: <32 hex>, customer: <string>, resumed: <bool>,
  heartbeatMs, deadAfterMs, maxMessageBytes, inlineMaxBytes, partBytes, maxFileBytes, maxValueBytes,
  kernel: { odc: <"1.7.28"|null>, o11: <"11.55.92"|null>, odcBridge: <"v35"|null> },
  compatible: { odc: Compat, o11: Compat } }
Compat = { ok: true } | { ok: false, code: "STUDIO_VERSION_MISMATCH"|"STUDIO_NOT_INSTALLED"|"AGENT_PACK_MISMATCH"|"LANE_DISABLED"|"KERNEL_UNAVAILABLE", message: <string> }
# A-M1 (seção 7): STUDIO_VERSION_MISMATCH também traz cause, studio (a identidade), served e installed; outro build
# atendido com aviso é { ok: true, studio, warning: { code: "studioBuildDiffers", ... } }. welcome.kernel pode trazer
# builds { odc, o11 } (4 números) e studioBuildPolicy; o agente 0.3.1 lê só kernel[faixa].
```

### 3.3 Mensagens do stream (servidor → agente)

| Tipo | Campos | Exemplo |
|---|---|---|
| `call` | `id` (uuid), `kind` (seção 4.4), `params` (objeto) ou `paramsBlob` (BlobRef), `deadline` (epoch ms) | `{"t":"call","id":"0c9e…","kind":"odc.pipe","params":{"pid":4120,"version":"v35","args":["status","brief"]},"deadline":1759600000000}` |
| `ping` | `seq` (inteiro crescente), `at` (epoch ms) | `{"t":"ping","seq":41,"at":1759599990000}` |
| `close` | `reason`: `revoked`\|`expired`\|`replaced`\|`rotated`\|`server-stop`\|`protocol-error`; `message` | `{"t":"close","reason":"revoked","message":"Token revogado pelo dono do servidor."}` |

### 3.4 Mensagens de subida (agente → servidor, dentro de `{messages:[...]}`)

| Tipo | Campos | Regra |
|---|---|---|
| `accepted` | `id` | enviado ao receber um `call`. Distingue "não entregue" de "entregue sem resultado" |
| `result` | `id`, `ok:true`, `value` ou `valueBlob`; ou `ok:false`, `error: {code, message, executed?: bool\|null, sent?: bool}` | um por `call` |
| `pong` | `seq`, `versions?: {studios, o11Connection}` | `versions` só quando mudou desde o último relato |

Exemplos:

```json
{"messages":[{"t":"accepted","id":"0c9e…"}]}
{"messages":[{"t":"result","id":"0c9e…","ok":true,"value":{"line":"{\"ok\":true,\"bridge\":\"v35\",\"busy\":null}","paths":[]}}]}
{"messages":[{"t":"result","id":"7b21…","ok":false,"error":{"code":"PIPE_ABSENT","message":"The ODC bridge v35 is not attached to ODC Studio 4120","sent":false}}]}
{"messages":[{"t":"pong","seq":41}]}
```

Caixa de saída do agente (no lugar de um mapa de deduplicação por tempo):

- Toda mensagem de subida entra numa fila. Um POST leva a fila em lote; a resposta 204 confirma o lote inteiro. Sem
  204 (queda, 5xx), o lote fica e vai de novo depois da reconexão.
- O agente guarda `id → running | done` de cada `call` até o `result` dele ser confirmado por um 204. Um `call` com um id
  que está nesse mapa nunca roda de novo: `running` reenfileira `accepted`; `done` já tem o `result` na fila. Depois da
  confirmação o servidor já tirou a pendente e nunca reenvia aquele id. O mapa é limitado pelas 32 pendentes do
  servidor.
- Reinício do agente = nova `instance` = mapa vazio; por isso a substituição falha as pendentes antigas.

### 3.5 Códigos de erro

Canal e HTTP:

| Código | HTTP | Significado |
|---|---|---|
| `AGENT_CREDENTIAL_MISSING` / `AGENT_CREDENTIAL_UNKNOWN` | 401 | sem credencial ou desconhecida (inclusive a anterior a um `agent-rotate`) |
| `AGENT_REVOKED` / `AGENT_EXPIRED` | 403 | token revogado ou vencido; o agente sai (código 2) |
| `AGENT_PROTOCOL_UNSUPPORTED` | 409 | `protocol` diferente de `ssam-agent/1`; o agente sai (código 4) |
| `CHANNEL_UNKNOWN` | 404 | canal inexistente, de outro token, substituído ou fechado |
| `MESSAGE_TOO_LARGE` | 413 | corpo acima de `maxMessageBytes` ou parte acima de `partBytes` |
| `PART_HASH_MISMATCH` / `TRANSFER_INVALID` / `TRANSFER_CONFLICT` | 400 / 400 / 409 | parte com sha256 errado; `transfer` ou `index` fora do formato; parte repetida com conteúdo diferente |
| `RATE_LIMITED` | 429 | limite de pedidos do agente |
| `FORWARDED_REFUSED` | 403 | `--local-studios`: pedido com cabeçalho de proxy (9.1) |

Chamadas (em `error.code` do `result`, ou gerados pelo hub/`AgentExecutor`):

| Código | `executed` | Origem |
|---|---|---|
| `AGENT_NOT_CONNECTED` | false | nenhum canal vivo no momento da chamada |
| `AGENT_BUSY` | false | 32 chamadas pendentes no token |
| `AGENT_DISCONNECTED` | false se nunca escrita em um stream; senão desconhecido | canal caiu e o prazo venceu sem retomada, instância substituída ou credencial trocada |
| `AGENT_TIMEOUT` | idem | prazo vencido |
| `AGENT_REVOKED` | idem | revogação durante a chamada |
| `AGENT_PROTOCOL_VIOLATION` | desconhecido se entregue | caminho do agente fora das regras de `fromAgent` (6.2), ou `paths` malformado ou apontando para algo que não é texto `agent:` (4.4); nada é gravado nem lido e o canal fecha com `protocol-error` |
| `VALUE_TOO_LARGE` | desconhecido | valor de resultado acima de `maxValueBytes` (2.6): o agente recusa sem subir; o servidor recusa antes de ler as partes |
| `HOSTED_CONTEXT_LOST` | false | `DenyExecutor`: chamada de máquina sem contexto hospedado num processo servido (4.1) |
| `KIND_NOT_ALLOWED`, `COMMAND_NOT_ALLOWED`, `METHOD_NOT_ALLOWED` | false | fora da lista do agente |
| `PATH_FORBIDDEN`, `PATH_NOT_AGENT` | false | caminho fora das pastas permitidas; posição de caminho sem `agent:` |
| `PATH_OUTSIDE_WORKSPACE`, `PATH_NOT_STAGEABLE`, `HOSTED_PATH_PARAM_REFUSED` | false (`sent:false`) | espelho no servidor (4.5/4.6), antes de chamar o agente |
| `FILE_NOT_FOUND`, `FILE_TOO_LARGE`, `BLOB_HASH_MISMATCH`, `WORKSPACE_FULL` | false | arquivos |
| `BRIDGE_VERSION_MISMATCH`, `STUDIO_VERSION_MISMATCH`, `LANE_DISABLED`, `O11_NOT_CONNECTED`, `STUDIO_NOT_SELECTED`, `ATTACH_FAILED` | false | estado do agente/Studio |
| códigos do transporte local, repassados como vêm: `PIPE_ABSENT`, `PIPE_BUSY`, `BRIDGE_NOT_ATTACHED`, `BRIDGE_BUSY`, `PIPE_CONNECT_TIMEOUT`, `PIPE_REPLY_TIMEOUT`, `PIPE_NO_REPLY`, `PIPE_TRANSPORT`, `PIPE_REPLY_TOO_LARGE`, `BRIDGE_NOT_LISTENING`, `BRIDGE_TIMEOUT`, `BRIDGE_TRANSPORT`, `BRIDGE_PROTOCOL`, `BRIDGE_NO_REPLY`, `BRIDGE_REPLY_TOO_LARGE` | como hoje (`sent`/`executed`) | `odc-pipe.mjs` e `o11-bridge.mjs` |

Códigos no nível da ferramenta (o que o LLM do cliente recebe): `HOSTED_UNAVAILABLE`, `HOSTED_LANE_DISABLED`,
`AGENT_NOT_CONNECTED`, `STUDIO_VERSION_MISMATCH`, `AGENT_PACK_MISMATCH`, `O11_NOT_CONNECTED`, `WORKSPACE_FULL`,
`PATH_OUTSIDE_WORKSPACE`, `PATH_NOT_FOUND`, `PATH_NOT_STAGEABLE`, `HOSTED_STUDIO_SESSION_ONLY`,
`HOSTED_PROMPT_UNAVAILABLE`, `HOSTED_PATH_PARAM_REFUSED`, `HOSTED_CONTEXT_LOST`, `COMPONENT_STALE`. Desde a fase 3 não
existe mais `HOSTED_BASE_REQUIRED`: `ssam_job {lane:"odc"}` sem `base` roda na fixture neutra
([O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md) §7.2).

## 4. A costura do executor

### 4.1 Interface e contexto (`platforms/odc/facade/executor.mjs`, faixa `seam`)

```js
// Every machine-touching call of the facade goes through currentExecutor().call(kind, params, options).
export const CALL_KINDS: readonly string[];      // the 9 kinds of 4.4, frozen
export const MACHINE_KINDS: readonly string[];   // studio.processes, odc.pipe, odc.attach, o11.bridge, o11.connect, o11.selected
export class LocalExecutor {                      // today's behavior: the default in stdio, the CLI and tests
  readonly id = 'local'; readonly hosted = false;
  call(kind: string, params: object, options?: { timeoutMs?: number }): Promise<any>;   // file.* -> KIND_NOT_ALLOWED
  o11Connection(): undefined;                     // undefined: callers read the connection file as today
  close(): Promise<void>;
}
export class DenyExecutor {                       // the default of a served process (ssam serve without --local-studios)
  readonly id = 'deny'; readonly hosted = false;
  call(): Promise<never>;                         // rejects Error {code:'HOSTED_CONTEXT_LOST', executed:false}
  o11Connection(): null; close(): Promise<void>;
}
// Executor contract implemented by LocalExecutor, DenyExecutor and hosted/agent-executor.mjs AgentExecutor:
//   id: string; hosted: boolean; call(kind, params, options) -> Promise<result>; o11Connection() -> record|null|undefined; close()
export function setDefaultExecutor(executor): Executor;   // process-wide; returns the previous one (tests restore it)
export function runWithExecutor(context: HostedContext | { executor: Executor }, fn: () => any): any;   // AsyncLocalStorage.run
export function currentExecutor(): Executor;              // the context's executor, else the process default
export function hostedContext(): HostedContext | null;    // null outside a hosted call
export function servedWithoutContext(): boolean;          // no context and the process default is a DenyExecutor
export function workspacePath(...segments: string[]): string;     // hosted: join(context.workspace, ...); throws otherwise
export function hostedSpawnEnv(lane: 'o11' | 'odc'): { env: object, cwd: string };   // 4.7; throws O11_NOT_CONNECTED / HOSTED_CONTEXT_LOST
export function fileVersion(exePath: string): Promise<string|null>;  // ProductVersion of a Windows exe (PowerShell), for kernel versions
export async function createHostedContext({ tokenId, customer, lanes, agent, workspace }): Promise<HostedContext>;
// HostedContext = { id, hosted: true, tokenId, customer, lanes: string[], workspace: string (absolute),
//                   agent: AgentLink (I-1), executor: AgentExecutor, close(): Promise<void> }
```

- `createHostedContext` cria o layout do workspace (6.1), grava `<ws>/odc/tenants.json` =
  `{"default":null,"tenants":{}}` quando falta, grava uma chave NOVA do relay em
  `<ws>/state/relay-authority/bridge.key` (32 bytes aleatórios em base64url), lê a pasta do Studio do kernel O11 do
  servidor (`o11LaneOf().studioDir`, calculada fora do contexto), importa DINAMICAMENTE `./hosted/agent-executor.mjs`,
  constrói `new AgentExecutor({ link: agent, workspace, relayAuthorityDir, o11: { studioDir, lane } })` e chama
  `await executor.start()` (abre o relay O11). A chave do controlador do servidor (`readAuthorityKey()`) não entra.
- **Padrão do processo.** `runServed` (faixa `hosted`), quando não é `--local-studios`, chama
  `setDefaultExecutor(new DenyExecutor())` antes de escutar. Fora de um contexto hospedado, todo tipo de máquina falha
  com `HOSTED_CONTEXT_LOST` (`executed:false`), e os auxiliares de raiz de dados e `hostedSpawnEnv` também lançam
  `HOSTED_CONTEXT_LOST` (`servedWithoutContext()`). Assim um contexto perdido (o `wrap` de módulo de `mcp.mjs:21-24`,
  handlers de `registerOdcTools`/`registerStudioCreateApp`, callbacks de objetos criados fora do contexto, o
  `prefetch` destacado do índice) falha fechado em vez de cair no `LocalExecutor` e no Studio do dono.
- `LocalExecutor.call` dentro de um contexto hospedado lança `SEAM_LOCAL_IN_HOSTED` (guarda contra import direto).
- **Onde o contexto é posto.** Em volta de cada chamada de ferramenta (faixa `hosted`, em `ssam.mjs`, inclusive
  `ssam_friction` e os proxies ODC) e em volta da construção da sessão (`createSsamServer` construído dentro de
  `runWithExecutor`). `createFacadeServer` (`mcp.mjs`) captura `hostedContext()` ao ser construído; quando não é nulo,
  troca `server.registerTool` ANTES de qualquer registro, de modo que todo handler (os próprios, `registerAccessTools`,
  `registerOdcTools`, `registerStudioCreateApp`, `registerDebugTools`) roda dentro de `runWithExecutor(capturado)`.
  O `wrap` de módulo continua como está: ele não guarda estado; o contexto vem da troca.
- **Regra das raízes.** Num contexto hospedado, todo auxiliar de raiz de DADOS da tabela 6.1 devolve o caminho
  hospedado quando o `root` recebido falta ou é o padrão (`anvilRoot`, ou a raiz ODC `lib.mjs root`); um `root`
  diferente (testes, bancada) continua valendo. Isso cobre as raízes capturadas no registro com `anvilRoot` explícito
  (`o11-cycle.mjs:486/503` `tasksDir(root)`, `ssam-task.mjs:68`, `job-runner.mjs:96-100`, `ssam-reference.mjs:172`,
  `studio-create-app.mjs:115-124`), porque o registro acontece dentro do contexto. Locais de CÓDIGO nunca mudam: CLI,
  builder, cliente da bridge, `studio/`, `portal/runtime`, catálogos do kernel, fixtures. `lib.mjs` continua exportando
  `root` (código) e `paths`; os campos de dados de `paths` (`tenants`, `catalog`, `journal`) viram getters pelo
  contexto, e `module-map.mjs:16`/`mcp.mjs:96` continuam usando `root` só para código (o manifesto chega absoluto).
- **Caches de módulo com fatos da máquina** são chaveados por `currentExecutor().id` ou desligados no hospedado:
  `lib.mjs:66-78` `pidListing` (lista de pids do ODC por 30 s), `lib.mjs:457-491` `access` (um `OdcAccess` por contexto,
  mapa por `context.id`), `studio-connect.mjs:139` `verifiedO11` (não usado no hospedado: `o11.selected`).

### 4.2 `AgentExecutor` (`platforms/odc/facade/hosted/agent-executor.mjs`, faixa `hosted`)

```js
export class AgentExecutor {
  constructor({ link /* AgentLink */, workspace /* abs */, relayAuthorityDir /* abs, <ws>/state/relay-authority */,
                o11: { studioDir, lane }, log? });
  readonly id: string; readonly hosted = true;
  start(): Promise<void>;                 // reads the relay key, opens the O11 relay (hosted/o11-relay.mjs) on 127.0.0.1:0
  call(kind, params, options?): Promise<any>;   // stages files (4.5/4.6), forwards with link.call, unstages
  o11Connection(): object | null;         // synchronous; the record the O11 modules read (4.7)
  relayPort(): number;
  close(): Promise<void>;                 // closes the relay
}
```

Ele não importa `executor.mjs`. Importa só `odc-pipe.mjs` (para `PipeError`) e `o11-bridge.mjs` (para `BridgeError`),
que já existem na base e ficam congelados (10.2). Testa sozinho com um `AgentLink` falso.

### 4.3 Erros e incerteza

Os chamadores continuam vendo os erros de hoje, com os mesmos campos:

| Tipo | Erro lançado | Não entregue | Entregue, sem resultado |
|---|---|---|---|
| `odc.pipe` | `PipeError` (`odc-pipe.mjs`) | `{code, sent:false}` (ex.: `AGENT_NOT_CONNECTED`, `PATH_NOT_STAGEABLE`) | `{code:'AGENT_DISCONNECTED'\|'AGENT_TIMEOUT'\|'AGENT_PROTOCOL_VIOLATION', sent:true}` |
| `o11.bridge` | `BridgeError` (`o11-bridge.mjs`) | `{code, method, executed:false}` | `{code, method, executed:undefined}` |
| demais | `Error` com `code` e `executed` | `executed:false` | `executed:null` |

Com isso `guardDeliveryStep` (lib.mjs), `deliverOutcome` (o11-cycle.mjs), `StudioBridge.exchange`
(service-center/bridge.mjs) e o relay continuam marcando como incerto o que pode ter sido executado, e nunca repetem.

### 4.4 Tipos de chamada (a lista fechada)

O agente recusa qualquer outro tipo (`KIND_NOT_ALLOWED`). O servidor nunca manda código, script ou caminho de DLL.

| Tipo | `params` | Resultado | Local (código que passa para trás da costura) | Agente | Prazo |
|---|---|---|---|---|---|
| `studio.processes` | `{image:"ServiceStudio.exe"\|"ODCStudio.exe"}` (no local, `paths:false` quando só os pids importam) | `{processes:[{pid, path, version}]}` | `lanes.mjs studioProcesses` (CIM), `lib.mjs studioPids` e `service-center/auth.mjs studioRunning` (tasklist com `paths:false`, como antes da costura: 15 s, erro propagado) | mesma consulta CIM + `ProductVersion` do executável | 60 s |
| `odc.pipe` | `{pid, version, args:[string], connectMs?}` | `{line, paths}` (uma linha JSON da bridge; `paths` abaixo) | `lib.mjs client()` → `odc-pipe.mjs pipeCall` | `pipeCall` local; `version` tem de ser a do pacote (`BRIDGE_VERSION_MISMATCH`); comando, posições e linha final conferidos (4.8) | `replyTimeoutMs(args)` + `connectMs` + 60 s |
| `odc.attach` | `{pid}` | `{ok, attached, pid, version, note}` | `lib.mjs client(pid,['attach', dll])` (cliente .NET) | cliente e bridge DO PACOTE; nenhum caminho vem do servidor | 120 s |
| `o11.bridge` | `{method, params, timeoutMs?}` | `{reply:{success, data?, error?, code?, executed?}, paths}` | `o11-bridge.mjs o11Bridge` (cliente sobre `bridgeRequest`), `studio-connect.mjs bridgeCall/probeO11/pingO11/authenticate`, `service-center/bridge.mjs StudioBridge.request` | sempre a porta do PRÓPRIO registro do agente; põe a chave local; método e posições conferidos (4.8) | `timeoutFor(method, params)` + 60 s |
| `o11.connect` | `{pid?}` | registro `{ok, lane:"o11", connected, reused, pid, startedUtc, studioVersion, port, uiResponsive, connectedAt}` | `studio-connect.mjs connectO11` | attach com os binários pré-compilados do pacote (4.9) | 300 s |
| `o11.selected` | `{}` | `{connected, pid, startedUtc, version}` | `studio-connect.mjs assertSelectedO11` | ping + `Anvil.Connect describe` contra o registro do agente; nunca muda variável de ambiente | 60 s |
| `file.put` | `{path:"agent:<rel>", blob: BlobRef, json?:"agent-paths"}` | `{path, sha256, size, skipped}` | — (só existe entre servidor e agente) | grava só em pastas graváveis (6.2); `skipped:true` sem baixar quando o arquivo já tem o sha256 | 10 min |
| `file.get` | `{path:"agent:<rel>", json?:"agent-paths"}` | `{path, blob: BlobRef}` | — | lê só pastas legíveis (6.2) | 10 min |
| `file.list` | `{path:"agent:<pasta>", max?: ≤ 2000}` | `{entries:[{path, size, sha256, mtimeMs}], truncated}` (recursivo) | — | idem | 120 s |
| `net.probe` (fase4-24, 2.10) | `{probes?: [{bytes, count}], budgetMs?}` | `{budgetMs, ms, probes:[{id, bytes, ms, ok, status, via?, serverMs?, error?}]}` | — | sobe bytes aleatórios para `/agent/v1/probe/<id>`, cada subida numa conexão nova; nada da máquina é lido ou gravado | `budgetMs` + 5 s |

Saíram da lista da revisão anterior: `studio.locate` (nenhum chamador em tempo de execução: só
`scripts/release/checkout-identity.mjs:30` usa `locateStudio`), `file.stat` (`file.put` já pula por sha256 e
`file.list` traz o sha256) e `agent.info` (`link.info()` já guarda o `Hello` e os `pong.versions`).

- `o11.bridge` não leva `port` nem `authorization`: o `AgentExecutor` remove os dois antes de enviar. A porta que os
  chamadores do servidor conhecem é a do RELAY (4.7), e nenhuma chave do servidor vai para a máquina do cliente.
- `json:"agent-paths"` só vale para o manifesto ODC e só nos campos que a bridge lê (`studio/shared/Manifest.cs:14-32`):
  `basePath`, `candidatePath`, `producerPath`, `builderReceipt`, `evidenceDir`. Em `file.put` o agente troca o valor
  `agent:<rel>` desses campos pelo caminho absoluto confinado e recusa (`PATH_FORBIDDEN`) um valor absoluto neles; em
  `file.get` faz o inverso nesses campos. Os demais campos não são tocados.
- Respostas de `odc.pipe` e `o11.bridge`: o agente troca, em profundidade, todo texto que seja caminho absoluto sob a sua
  raiz (num prefixo legível) por `agent:<rel>` e devolve em `paths` o caminho de chaves de cada texto trocado
  (`[["path"], ["data","modules",0,"file"]]`: nome de campo ou índice de lista; em `odc.pipe`, dentro do JSON da linha).
  O `AgentExecutor` troca de volta por caminhos do workspace, sempre por `fromAgent` (6.2), SÓ nesses textos e nos campos
  que o servidor lê como arquivo (`path` de `snapshot`/`latest` ODC com `ok:true`; `data.path` de `snapshot_module` e
  `data.value.FilePath` de `download` O11), que TÊM de ser `agent:` mesmo fora de `paths`. Todo outro texto, mesmo o que
  começa com `agent:` (um valor de registro, uma resposta do Portal ou do Service Center), é dado e passa intacto. `paths`
  malformado ou apontando para algo que não é texto `agent:` é `AGENT_PROTOCOL_VIOLATION`. `paths` não sai do servidor.

### 4.5 Espelho ODC (`hosted/odc-stage.mjs` e `hosted/mirror.mjs`, faixa `hosted`)

A raiz da bridge ODC no cliente é `<agentRoot>\odc` (a bridge acha a raiz subindo da própria DLL até achar `studio\` e
`README.md`, `StartupHook.cs:43-48`; seção 6.2). O workspace do servidor tem o mesmo layout em `customers/<tokenId>/odc`.

Regra de espelho (vale para ODC e O11):

1. Mapeamento: `<ws>/<rel>` ↔ `agent:<rel>`, com `<rel>` começando por `odc/`, `o11/` ou `inbox/`.
2. **Entrada** (arquivo que a bridge só lê): dentro de um prefixo gravável do agente (6.2) vai no mesmo `<rel>`; em outro
   lugar do workspace (por exemplo `inbox/`, ou uma pasta ODC não gravável) é copiado antes para
   `<ws>/<faixa>/journal/staging/<sha256><ext>` e vai como esse `<rel>`; fora do workspace: `PATH_OUTSIDE_WORKSPACE`
   sem chamar o agente. Um `.oml` leva junto o `.json` irmão quando ele existe no servidor (mesmo nome + `.json`).
3. **Saída** (arquivo ou pasta que a bridge escreve): tem de estar num prefixo gravável do agente; senão
   `PATH_NOT_STAGEABLE` sem chamar o agente. A política (6.3) já põe saídas relativas em `ws:odc/lab/` e `ws:o11/`.
4. **Direção.** Servidor → agente: só o que o servidor escreveu (manifesto, base, candidato, produtor, recibo do builder,
   pedidos) ou o que falta no agente. Agente → servidor: o que a bridge escreveu. Uma cópia do servidor nunca sobrescreve
   no agente um recibo da bridge (o `publish` lê o recibo do `merge`).
5. Envio por sha256: `link.putFile` + `file.put`; o agente responde `skipped:true` sem baixar quando já tem o arquivo.
   Vinda: `file.list` (com sha256) para pastas e `file.get` + `link.receiveBlob` só do que difere.
6. Todo caminho que vem do agente (os textos de `paths` e os campos lidos como arquivo de uma resposta, 4.4; entradas de
   `file.list`, `valueBlob`, destino de vinda) passa por `fromAgent` (6.2). O resto da resposta é dado.

| Comando da bridge | Posição | Papel | Antes | Depois |
|---|---|---|---|---|
| `check-base`, `preview`, `merge`, `publish`, `publish-status`, `create`, `authorize`, `create-app` | `args[1]` (manifesto) | saída (a pasta do manifesto e `evidenceDir` têm de ser graváveis) | lê o manifesto; envia `basePath`, `candidatePath`, `producerPath`, `builderReceipt` (regra 2); envia `manifest.json` com esses campos e `evidenceDir` reescritos para `agent:` e `json:"agent-paths"`; da pasta do manifesto envia só o que falta no agente | traz da pasta do manifesto e de `evidenceDir` tudo o que difere (agente → servidor), inclusive `manifest.json` com `json:"agent-paths"`, que o `authorize` altera |
| `open` | `args[2]` (OML local, opcional) | entrada | envia | — |
| `data-insert`, `data-update` | valor depois de `--records-file` | entrada | envia para `agent:odc/journal/data/requests/<nome>` | — |
| `data` | valor depois de `--out` | saída | — | traz o arquivo |
| `portal-call` | `args[1]` (pedido) | entrada | envia para `agent:odc/journal/portal/requests/<nome>` | — |
| `portal-session` com `args[1] = "fetch"` | `args[2]` (pedido; `portal/runtime/studio-portal.mjs:38-40`) | entrada | envia para `agent:odc/journal/portal/requests/<nome>` | — |
| `reference-snapshot` | `JSON.parse(args[1]).output` | saída | reescreve para `agent:` | traz o arquivo |
| todos | resposta | — | — | cada `agent:<rel>` da resposta passa por `fromAgent`; o que for arquivo é trazido (e o `.json` irmão de cada `.oml`); `assets` traz também `odc/snapshots/modules.json`; os textos `agent:` viram caminhos do servidor |

O comando `attach` nunca vai por `odc.pipe` (só por `odc.attach`). Sem o espelho de `portal-session fetch`,
`odc_portal_read`/`odc_portal_write`/`odc_portal_routes` e os auxiliares tipados do Portal falhariam no hospedado.

### 4.6 Espelho O11 e relay do bridge (`hosted/o11-stage.mjs`, `hosted/o11-relay.mjs`, faixa `hosted`)

Mesma regra de espelho de 4.5, com `<ws>/o11/<rel>` ↔ `agent:o11/<rel>` (todo `o11/` é gravável no agente).

| Método | Parâmetro | Papel | Ação |
|---|---|---|---|
| `snapshot_module` | `params.path` | saída | reescreve; com sucesso, `data.path` TEM de voltar como `agent:` (senão `AGENT_PROTOCOL_VIOLATION`): traz o arquivo e põe o caminho do servidor em `data.path` |
| `merge_from_oml` | `params.foreign_path`, `params.base_path`, `params.first_pass_path` | entrada | envia por sha256 (a base costuma ser a captura que acabou de vir do agente: pulada); reescreve. `first_pass_path` é a cópia de primeira passada da ordem do merge (oitava entrega) |
| `environment_session` com `operation:"download"` | `params.arguments.outputDirectory` | saída (pasta) | `null` → `agent:o11/downloads/<id>` (o kernel chama com `null` em `Publisher.cs:297` e com a pasta temporária em `Publisher.cs:331`/`ReferenceRefresher.cs:108`; com `TEMP` no workspace, 4.7, a pasta temporária já é do workspace); caminho do workspace → reescreve; `data.value.FilePath` TEM de voltar como `agent:` e é trazido |
| `sc_api` (`UploadAndPublishExtension`, `PublishSolution`) | `params.args.file` | entrada | a bridge lê esse caminho local (`Anvil.Bridge/ScOperations.cs:114-120/282/291`) e a fachada passa um caminho do servidor (`service-center/studio-api.mjs:282/385-400`): envia para `agent:o11/journal/staging/<sha256><ext>` e reescreve |
| `sc_api`, `sc_web` | `params.args.outFile` | — | recusa `HOSTED_PATH_PARAM_REFUSED` (`executed:false`); a fachada não usa `outFile` |
| `login`, `export_modules`, `export_status` | — | — | recusa `METHOD_NOT_ALLOWED` (`login` leva arquivo de credencial; a exportação não é usada no hospedado) |
| todos | `port`, `authorization` | — | removidos antes de enviar (4.4) |
| todos | resposta | — | `fromAgent` nos textos de `paths` e nos campos lidos como arquivo (4.4); viram caminhos do servidor; o resto é dado |

O kernel O11 (C#) fala com a bridge sozinho (`BridgeClient`, porta de `--port`/`--bridge-port` ou
`ANVIL_BRIDGE_PORT`, chave de `BridgeAccess.ReadCredential()`). No hospedado ele fala com o **relay**:

- `hosted/o11-relay.mjs` abre um `net.Server` em `127.0.0.1:0` por `AgentExecutor` (um por cliente).
- Cada conexão: uma linha `{method, params, authorization}`. A `authorization` tem de ser a chave do relay DAQUELE
  cliente (`<ws>/state/relay-authority/bridge.key`, lida no `start()`), comparada em tempo constante. Qualquer outra,
  inclusive a chave do controlador do servidor e a de outro cliente:
  `{"success":false,"executed":false,"error":"Relay refused: not this customer's relay key"}`. Motivo: a chave do
  controlador é a que o Service Studio do próprio dono aceita; um CLI hospedado mal encaminhado, ou uma troca de porta
  entre os relays de dois clientes, nunca é autenticado.
- Encaminha com `call('o11.bridge', {method, params})` (com o espelho acima) e responde a linha da bridge.
- Não entregue → responde `{"success":false,"executed":false,"error":"AGENT_NOT_CONNECTED: ..."}`. Entregue sem
  resultado → fecha o socket SEM resposta (o kernel já trata isso como resultado desconhecido e não repete).
- Resposta que chega depois de o cliente do kernel desistir (socket fechado) é descartada e registrada
  (`event:"relay-late"`); o resultado fica desconhecido para o kernel, como hoje.

**Limite de tempo do kernel.** O `BridgeClient` do kernel tem `ReceiveTimeout` de 120 s por padrão
(`Adapters.SS11/BridgeClient.cs:8/14`; os verbos de ambiente usam 330 s, `Program.cs:271`). Pelo relay, o tempo de
espelho conta: a vinda da captura de `snapshot_module` (subida do cliente) e o envio do candidato de `merge_from_oml`.
Desde a fase 3, `hostedSpawnEnv('o11')` põe `ANVIL_BRIDGE_TIMEOUT_SECONDS=600` e o `BridgeClient` espera pelo menos
600 s no hospedado ([O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md) §4.4); no local nada muda. Continuam o envio pulado por
sha256 e o teste do relay com cliente lento (10.7); um módulo enorme num link muito lento ainda pode passar de 600 s, e
a entrega termina incerta (nunca repetida).

### 4.7 Registro de conexão O11 e ambiente do CLI no hospedado

`studio-session.mjs readConnection(root, lane)` no hospedado devolve `currentExecutor().o11Connection()`:

```
{ ok: true, lane: "o11", anvilLane: <lane do servidor>, pid, startedUtc, studioVersion,   // do agente
  port: <porta do relay>, studioDir: <Studio do KERNEL no servidor>,
  authorityDir: <ws>/state/relay-authority, connectedAt, hosted: true }
```

ou `null` quando o agente não tem Studio O11 conectado. O `AgentExecutor` mantém o último registro do agente em memória
(do `Hello`, dos `pong.versions` e dos resultados de `o11.connect`/`o11.selected`).

**Sem registro, nada O11 que precise do Studio roda.** Hoje, sem registro, vários pontos caem na porta da tabela (4516/4536) e o CLI usa a
chave herdada do dono: `o11-cycle.mjs:502`, `o11-access.mjs:297`, `job-runner.mjs:129/139` (`--bridge-port`),
`o11-bridge.mjs:66` (`bridgeTarget`), `service-center/bridge.mjs:157-166` (que lê o arquivo de registro direto),
`anvil-cli.mjs:18` (só põe `ANVIL_BRIDGE_PORT` quando o ambiente não tem), `lanes.mjs:210` (`data` com `process.env`
cru), `studio-connect.mjs:143-144` (`assertSelectedO11` volta calado sem registro); o kernel também cai em 4516
(`Program.cs:269-270/722-723`) e lê a autoridade de `ANVIL_AUTHORITY_DIR`, do HKCU do dono ou de `%LOCALAPPDATA%`
(`BridgeAccess.cs:12-14`). No hospedado (faixa `seam`):

- `o11LaneOf(nome)` devolve `local` = `<ws>/o11` (e `jobs`, `work`, `proofs`, `soak` abaixo dele), `cli` e `studioDir`
  do servidor, `worker` = null, e `bridge` como getter: a porta do relay do registro atual, ou `O11_NOT_CONNECTED` sem
  registro. Os pontos acima que leem `.bridge` falham fechados sem outra mudança de lógica.
- `locateStudioBridge` lê o registro por `readConnection` (nunca `anvilRoot/.local/connections`); sem registro lança o
  `STUDIO_NOT_CONNECTED` que já existe, com a continuação `ssam_connect`.
- `assertSelectedO11`: sem registro → `O11_NOT_CONNECTED`; `o11.selected` com `connected:false` → `O11_NOT_CONNECTED`;
  nunca muda `process.env`. `connectO11` → `o11.connect`; nunca grava `.local/connections` nem muda `process.env`
  (hoje `studio-connect.mjs:235-236` muda).
- O portão (faixa `hosted`, 10.7) recusa antes do handler, com `O11_NOT_CONNECTED`, toda ferramenta da faixa o11 cuja
  regra pede o agente, exceto `ssam_connect` e as de relatório.
- `lanes.mjs run`: `data` (que fala com o Studio) sem registro → `O11_NOT_CONNECTED` antes do spawn; `dependencies inspect`
  e `help` (leitura offline de OML e ajuda) não passam por `assertSelectedO11` no hospedado, como o portão os classifica.
- O que nunca fala com a bridge roda sem registro (o `apply` de `o11_job`/`ssam_job` sem `captureProducers`,
  `ssam_reference {lane:"o11"}`, `o11_access plan`, `o11_environment references`, `o11_dependencies inspect|help`): o
  processo filho recebe a porta do relay deste cliente (abaixo), e uma chamada de bridge ali termina no relay e no
  agente deste cliente, que recusam (`AGENT_NOT_CONNECTED`, ou `O11_NOT_CONNECTED` do agente sem registro). Nunca outro
  Studio. É o que a recusa de versão promete: as ferramentas só do servidor continuam funcionando.

**Ambiente do processo filho.** `hostedSpawnEnv(lane)` monta o ambiente de todo processo do kernel e do builder no
hospedado a partir de uma lista fechada, nunca de `process.env` inteiro:

- do processo do servidor, só: `SystemRoot`, `windir`, `ComSpec`, `PATH`, `PATHEXT`, `OS`, `PROCESSOR_ARCHITECTURE`,
  `NUMBER_OF_PROCESSORS`, `ProgramFiles`, `ProgramFiles(x86)`, `ProgramW6432`, `ProgramData`, `CommonProgramFiles`,
  `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `HOMEDRIVE`, `HOMEPATH`, `DOTNET_ROOT`, `ANVIL_ODC_STUDIO_DIR`,
  `ANVIL_ODC_FEATURES_DIR` (runtime e locais de código do servidor);
- sempre: `TEMP` = `TMP` = `<ws>/<faixa>/tmp` e `ANVIL_AUTHORITY_DIR` = `<ws>/state/relay-authority` (também nas
  execuções ODC: sem a variável, `BridgeAccess` iria ao HKCU do dono);
- O11: `ANVIL_BRIDGE_PORT` = porta do relay (do registro; sem registro, a do relay deste cliente, que está sempre
  aberto no contexto), `ANVIL_STUDIO_DIR` = Studio do kernel do servidor, `ANVIL_LANE` = faixa do servidor; só um
  executor sem relay (nenhum contexto hospedado real) leva `O11_NOT_CONNECTED` antes do spawn;
- ODC: `SSAM_HYBRID_ODC_ROOT` = `<ws>/odc` (o builder resolve por ela catálogo, `tenants.json` e diário,
  `studio/builder/Program.cs:101-104/180-183/226`);
- nunca `ANVIL_CSHARP_RUNTIME_REGISTRATION`: `CSharpRuntimeDelivery.cs:15-32` leria por ela (ou por
  `<autoridade>/csharp-runtime.json`) um arquivo de credencial e abriria `HeadlessSession.Connect` direto. A autoridade
  do relay não tem esse arquivo: a entrega C# de runtime falha fechada no hospedado (seção 11);
- `cwd` = `<ws>/<faixa>` (o kernel grava padrões relativos, `Program.cs:224/724`, e usa `Path.GetTempPath()`);
- `--port`/`--bridge-port` dos verbos O11 vêm só do registro (porta do relay).

Usam `hostedSpawnEnv`: `anvil-cli.mjs createAnvilRunner` (faixa ODC quando o assembly é `anvil-odc.dll`),
`lanes.mjs run` (inclusive `data`), `job-runner.mjs`, `kernel-delivery.mjs applyKernel`, `studio-create-app.mjs`,
`ssam-reference.mjs` e `lib.mjs builder`. Os processos compartilhados do servidor (leitores residentes, worker ODC,
índice de módulos) continuam com o ambiente do servidor e nunca falam com um Studio. O worker O11 da faixa fica
desligado no hospedado (`workerDisabled('o11')`). No lugar dele, cada cliente pode ter um worker O11 só seu
(`anvil-worker.mjs HostedO11Workers`, `hostedWorkerClient`): `dotnet <cli> serve` com o `hostedSpawnEnv('o11')` e o
`cwd` do processo frio daquele cliente, numa porta de loopback própria, com a chave do relay do cliente como chave de
controlador (`<ws>/state/relay-authority/bridge.key`, lida pelo worker na partida).

- Ambiente: o frio mais só as variáveis do pool (`HOSTED_O11_WORKER_VARIABLES`): `ANVIL_BASE_CACHE` (e
  `ANVIL_BASE_CACHE_ENTRIES`/`ANVIL_BASE_CACHE_MB` quando ligado), `DOTNET_GCHeapHardLimit`, `ANVIL_WORKER_MAX_COMMANDS`
  e `ANVIL_WORKER_IDLE_MINUTES`. Vêm do servidor (`SSAM_O11_WORKER_BASE_CACHE` padrão `off`, `SSAM_O11_WORKER_HEAP_MB`
  padrão 1536, `SSAM_O11_WORKER_MAX_COMMANDS` padrão 1000). Um valor do cliente nunca as substitui.
- A primeira chamada de cada cliente roda fria na hora; o worker sobe em segundo plano e serve a próxima. Os builds do
  `o11_deliver` (`o11-build-phase.mjs slotRunner`) também usam esse worker: uma chamada por vez, as outras frias.
- Chave por `tokenId`, nunca compartilhado; impressão digital (ambiente, pasta, CLI, chave) conferida a cada chamada: um
  contexto novo (porta e chave de relay novas) aposenta o worker ocioso e a chamada roda fria.
- Teto `SSAM_O11_WORKERS_MAX` (padrão 2; 0 desliga), contando os que ainda saem. Sem vaga, sai o ocioso usado há mais
  tempo, só depois de `SSAM_O11_WORKER_MIN_IDLE_MS` (padrão 2 min) sem uso; senão a chamada só roda fria. Parada após
  `SSAM_O11_WORKER_IDLE_MS` (padrão 10 min), quando o contexto fecha, ou depois da chamada em que o `VmRSS` passou de
  `SSAM_O11_WORKER_RSS_MB` (padrão 1200).
- `shutdown` com a chave só vai ao processo que o servidor subiu (pid e instância do ping). Outro pid, sem ping, falha na
  partida ou pid desconhecido: o servidor termina o próprio processo e não manda nada.
- Ocupado, partindo, sem vaga ou qualquer dúvida: o processo frio de hoje. Pedido escrito sem resposta é resultado
  desconhecido, nunca repetido; o worker espera o ping dizer livre (até o tempo da chamada) antes do `shutdown`.
- Entrega com `--checks`: o kernel solta a captura do `find_element` no fim de cada entrega (`Delivery.Run`,
  `ThinBridge.ReleaseCapture`), então o worker não guarda módulo entre entregas. Logs em `<ws>/o11/tmp/o11-worker`.

### 4.8 Listas e conferências do agente

- Comandos ODC aceitos em `odc.pipe` (o primeiro argumento): `status`, `wait`, `authorize`, `open`, `snapshot`,
  `latest`, `check-base`, `preview`, `merge`, `publish`, `publish-status`, `publish-log`, `dismiss-dialog`, `close`,
  `module-info`, `assets`, `consumers`, `create`, `create-app`, `templates`, `template-download`,
  `refresh-references`, `reference-snapshot`, `reference-producers`, `data`, `data-insert`, `data-update`, `data-delete`,
  `portal-call`, `portal-session`, `auth-status`, `stop`, `query-test`. Qualquer outro: `COMMAND_NOT_ALLOWED`.
  `query-test` entrou com a bridge v45. `reference-producers <Módulo>` entrou no 24º (bridge v96): só lê, sem caminho.
- Continuam fora da lista ODC: `portal-private-call`, `portal-private-download` e `portal-api-client-fixture-cleanup`
  (usam um pipe local e o cofre do dono, que não atravessam máquinas) e `portal-upload` (só o `odc_external_library`
  usa, e ela é indisponível no hospedado).
- Métodos O11 aceitos em `o11.bridge`, os 23 verbos da bridge fina na ordem do `bridge_manifest`: `ping`,
  `bridge_manifest`, `get_active_module`, `list_open_modules`, `get_errors`, `open_module`, `close_module`, `publish`,
  `windows`, `ui_alive`, `close_dialog`, `snapshot_module`, `merge_from_oml`, `merge_status`, `environment_session`,
  `sc_api`, `sc_web`, `sc_http`, `studio_login`, `sc_session`, `publish_log`, `refresh_references`,
  `answer_dependencies_dialog`. Qualquer outro: `METHOD_NOT_ALLOWED`. `refresh_references` entrou na nona entrega,
  `answer_dependencies_dialog` na `servidor/fase4` e `sc_http` no 24º, todos sem caminho
  ([O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md) §3.2, §14 e §16).
- Continuam fora da lista O11: `login`, `export_modules`, `export_status`, `find_element`, `get_flow_nodes`,
  `integration_import` e `query_test` (lógica do kernel), e `sc_private_http` e `sc_private_http_cookie` (o transporte
  privado do Service Center fica na máquina do dono).
- Posições de caminho conferidas (o valor tem de começar com `agent:`; absoluto → `PATH_NOT_AGENT`), com o papel das
  tabelas 4.5 e 4.6: entrada exige prefixo legível, saída exige prefixo gravável. ODC: manifesto (`args[1]` dos
  comandos de manifesto; saída), `open args[2]`, `--records-file`, `portal-call args[1]`, `portal-session fetch args[2]`
  (entradas), `data --out`, `reference-snapshot` `output` (saídas). O11: `snapshot_module path` e `environment_session
  download outputDirectory` (saídas), `merge_from_oml foreign_path`/`base_path`/`first_pass_path` e `sc_api args.file` (entradas);
  `sc_api`/`sc_web`/`sc_http` `args.outFile` → `PATH_FORBIDDEN`.
- **Linha final do `odc.pipe`.** A bridge lê UMA linha e divide o resto por espaços ela mesma (`StartupHook.cs:84-87`
  e os `Split(' ')` dos comandos), então conferir o array de argumentos não basta: `['open','Mod C:\\x.oml']` ou
  `['data-insert','M','E','--authorize','x --records-file C:\\segredo.json']` passariam um caminho nunca conferido. O
  agente: (1) recusa `\r`, `\n` ou NUL em qualquer argumento (`COMMAND_NOT_ALLOWED`); (2) troca cada `agent:` das
  posições e de qualquer outro argumento (este último com prefixo legível); (3) monta a linha
  `args.join(' ')`, divide por brancos e recusa (`PATH_FORBIDDEN`) todo pedaço que seja absoluto
  (`^[A-Za-z]:[\\/]`, `^[\\/]`), UNC (`^\\\\`) ou tenha um SEGMENTO `..` (`(^|[\\/])\.\.([\\/]|$)`) e não esteja sob
  `<agentRoot>` num prefixo legível. Reticências no texto do usuário ("pode publicar...") não são segmento `..`. A
  raiz do agente não tem branco (6.2), então um caminho trocado continua um pedaço só.
- **Versão do processo escolhido.** `odc.pipe`, `odc.attach` e `o11.connect` comparam os três primeiros números da
  `ProductVersion` do executável do pid com `Welcome.kernel` da faixa; diferente → `STUDIO_VERSION_MISMATCH`
  (`executed:false`). Cobre instalações lado a lado e a atualização automática do ODC Studio, que o `Hello` (versão
  instalada) não vê. O agente guarda `pid → version` da última listagem; um pid desconhecido dispara uma listagem.

### 4.9 Conexão O11 no agente

Igual a `connectO11` de hoje, sem compilar nada no cliente:

1. `studio.processes` (ServiceStudio.exe) e escolha do pid (um só, ou o `pid` pedido); versão conferida (4.8).
2. `bin\o11\connect\Anvil.Connect.dll describe <pid>` (versão do Studio precisa ser a `o11BuiltFor` do pacote).
3. Copia `bin\o11\hook\Anvil.RuntimeHook.Agent.dll` para `private\runtime-connect\<id>\` e grava ao lado o `.json`
   `{pid, startedUtc, port, bridgePath: bin\o11\bridge\Anvil.Bridge.dll, authorityDir: private\authority}`.
4. `Anvil.Connect.dll attach <pid> <startedUtc> <hook>`; espera a bridge responder (mesmo `pollWithBackoff`, 30 s).
5. Autentica com `private\authority\bridge.key` (a bridge cria a chave em `BridgeAccess.Initialize`).
6. Grava `private\o11-connection.json`. A porta vem da configuração do agente (`o11Port`, padrão 4516).

A mesma trava por porta de hoje (`private\runtime-connect\port-<porta>.lock`) e a mesma recusa de reanexar uma bridge
já carregada.

## 5. Classificação das 96 ferramentas

marco-a5 (`fase4-25/marco-a5`, 15/10/2026): entra a `ssam_code` (linha 94), indisponível no hospedado. São 96 ferramentas:
`createSsamServer` registra 91, mais as 4 do hook e a `ssam_friction`. Totais: servidor 23 (10 delas com um modo que usa o
agente), agente 33, tenant-agente 22 e indisponível 18. No ar, o `tools/list` sem o hook deve mostrar 92 (não conferido no ar).

a8 (`fase4-26/a8-ssam-code`, 18/10/2026, pedido do dono): a `ssam_code` passa a servidor (linha 94). Totais: servidor 24 (11
com um modo que usa o agente), agente 33, tenant-agente 22, indisponível 17. Os mesmos 96 nomes e 92 no `tools/list`.

Regras novas do marco-a5 no portão e na costura:

- Os ops de gerador que ainda esperam o teste cego (`entity-actions`, `rest-consume` e o op `screen` com `data.generate`) são
  recusados no portão das 4 ferramentas de job e entrega, antes do agente e de qualquer captura: `HOSTED_UNAVAILABLE`,
  `cause:"GENERATOR_PENDING"`, `policy:"HOSTED_GENERATOR_OPS"`. A chave é uma só (`HOSTED_GENERATOR_OPS = 'refuse'`). Um
  gerador que o dono aprovar (`generators.mjs`) passa como qualquer op.
- A amostra GET do `rest-consume` usa o cliente só-público (`hosted/public-fetch.mjs`), nunca o `fetch` global do servidor.
- O mapa `handlers` do `ssam.mjs` (por onde o `ssam_code write` entrega) guarda o handler com o portão.
- Os componentes do ambiente no `ssam_discover` O11 ficam desligados (`HOSTED_UNAVAILABLE`, `cause:"COMPONENTS_HOSTED_PENDING"`);
  o pacote de trabalho não lê o cache de produtores do servidor.
- `odc_portal_login` com `action` `prompt` ou `focus` (a janela privada de credencial do produto) responde
  `HOSTED_PROMPT_UNAVAILABLE` antes de ler o Studio, o cofre ou um perfil.
- As respostas que o produto agora encurta por tipo (`answer-size.mjs`) gravam a resposta inteira no mesmo lugar das
  paginadas: `ws:o11/answers`, lida só pelo `ssam_evidence` da mesma conta.

24º envio (`servidor/fase4-24`): o `catalog/tools.json` passa de 83 para 95 ferramentas, sem nenhuma removida.
`createSsamServer` registra 90, mais as 4 do hook e a `ssam_friction`. O `hosted/tools.json` cobre as 95. As 12 novas
são as linhas 82 a 93. Os totais passam a ser: servidor 23 (10 delas com um modo que usa o agente), agente 33,
tenant-agente 22 e indisponível 17. No ar, o `tools/list` sem o hook mostra 91.

Regras novas do 24º no portão (`hosted/policy.mjs`):

- O portão confina os argumentos que a ferramenta roda. A camada de entrada do 24º (`tool-input.mjs`) roda um campo
  corrigido com o nome certo (`targt` vira `target`). O `ssam.mjs` passa o `argsOf` dela ao portão. O portão resolve os
  caminhos sobre `argsOf(cru) ?? cru` e entrega ao handler esses argumentos já resolvidos (risco R1).
- Um job com o op `prototype` é recusado no portão, antes de qualquer captura, em `o11_deliver`, `studio_deliver`,
  `ssam_job` e `o11_job`: `HOSTED_UNAVAILABLE`, `cause:"PROTOTYPE_SOURCE_LOCAL"`. A chave é uma só:
  `HOSTED_PROTOTYPE_OP` (`'refuse'` no 24.0; `'allow'` libera). Vale para o job inline, o job parcial, o patch e os
  arquivos de job (`/job`, `/basedOn/job`).
- `authorizationContext` (novo no 24º) é caminho de entrada em toda ferramenta hospedada que o recebe. O arquivo de
  proposta que ele cita também tem de estar na área visível do workspace (`authorization-context.mjs`).

Fonte (até o 23º): os registros reais. `createSsamServer` registra 78 ferramentas (26 próprias de O11/núcleo, com `ssam_grant`
desde a nona entrega, + 52 do proxy da fachada ODC: 3 `ssam_*` + 29 `studio_*` + 6 do catálogo do Portal + 13 de acesso
+ `hybrid_tenants`); o modo servido acrescenta `ssam_friction` (79), registrada pelo protótipo, por fora da troca de
`registerTool`: o portão a envolve explicitamente. `catalog/tools.json` lista exatamente as mesmas 79.

Classes:

- **servidor**: roda inteiro no servidor, no workspace do cliente. Nunca toca Studio, máquina ou sessão de ninguém.
- **agente**: um ou mais passos rodam no Studio/máquina do cliente pelo agente.
- **tenant-agente**: alcança o tenant/ambiente só com a sessão do Studio do cliente, executada dentro do Studio dele
  pelo agente. Cofre, API Client, prompt e HTTP direto do servidor são recusados (`HOSTED_STUDIO_SESSION_ONLY`,
  `HOSTED_PROMPT_UNAVAILABLE`).
- **indisponível**: recusada com `HOSTED_UNAVAILABLE` e o motivo.

Décima sexta entrega (`b01cef95`): o produto tem 78 ferramentas (77 de createSsamServer + ssam_friction). As 4 do hook
(context, propose, continue, status) só aparecem com SSAM_APP_HOOK_TOOLS=1; aqui seguem classificadas como
indisponíveis, listadas ou não. Entraram ssam_preview, o11_extension e odc_external_library, as três indisponíveis no
hospedado (linhas 79 a 81). hosted/tools.json cobre as 82 (78 + 4 do hook).

Totais até o 23º: servidor 22 (10 delas com um modo que usa o agente), agente 32 (31 mais a `ssam_query_test`, linha
51a), tenant-agente 19, indisponível 10. A nona
entrega (`ce7c6b25`) trouxe `ssam_grant` (79 com `ssam_friction`), `ssam_task close`, `publish:true` em `o11_deliver` e
`studio_deliver`, o lote do `o11_data` e as respostas paginadas; as linhas abaixo e a seção 6.1 dizem onde cada uma fica.

Toda ferramenta da faixa o11 cuja regra pede o agente exige também a conexão O11 do cliente (`O11_NOT_CONNECTED`,
seção 8), exceto `ssam_connect` e as de relatório.

| # | Ferramenta | Classe | Precisa do agente quando | Faixa (lane) | Motivo |
|---|---|---|---|---|---|
| 1 | `ssam_discover` | servidor | `app` é nome de módulo (não caminho) | arg `lane`, padrão odc | catálogo e índice no servidor; `app` com nome de módulo captura pelo Studio do cliente |
| 2 | `ssam_map` | servidor | `target` é nome de módulo | arg, padrão odc | índice do módulo no servidor; captura do módulo aberto via agente |
| 3 | `ssam_app_url` | servidor | sem `environment` e sem `tenant` (lê o status do Studio) | odc | URL construída com os tenants do CLIENTE |
| 4 | `ssam_reference` | servidor | nunca | arg | catálogos do kernel |
| 5 | `ssam_evidence` | servidor | nunca | nenhuma | lê só JSON de `odc/`, `o11/` e `inbox/` do workspace do cliente |
| 6 | `ssam_task` | servidor | `close` presente | nenhuma | tarefas do workspace (`<ws>/o11/tasks`); `close` roda o fechamento do kernel numa tarefa da pasta de trabalho DO CLIENTE (`<ws>/o11/work`), e a prova por hash captura o módulo pelo relay. Id de outro cliente nunca é achado |
| 7 | `ssam_job` | servidor | `captureProducers` não vazio (O11) | arg, padrão o11 | prova em fixture no servidor; captura de produtor pela sessão do Studio; `lane:"odc"` sem `base` roda na fixture neutra `blank-crossdevice.oml` no hospedado (pergunta 11, [O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md) §7.2); job com op `prototype` recusado (`PROTOTYPE_SOURCE_LOCAL`) |
| 8 | `o11_job` | servidor | `captureProducers` não vazio | o11 | idem |
| 9 | `o11_inspect` | servidor | `module` presente | o11 | leitor residente no servidor; `module` captura pelo bridge |
| 10 | `studio_inspect` | servidor | `target` é nome de módulo | odc | leitor no servidor; nome de módulo captura pelo Studio |
| 11 | `o11_access` | servidor | `action` = `apply` | o11 | `plan` é offline; `apply` executa entregas pelo bridge (relay) |
| 12 | `odc_receipt` | servidor | `reconcile` presente | odc | recibos no workspace; a reconciliação faz uma leitura no tenant |
| 13 | `studio_build` | servidor | nunca | odc | builder headless no servidor com `SSAM_HYBRID_ODC_ROOT=<ws>/odc`; builder desatualizado → `COMPONENT_STALE` (nunca `dotnet build` no hospedado) |
| 14 | `studio_manifest` | servidor | nunca | odc | manifesto no servidor |
| 15 | `odc_status` | servidor | nunca | odc | cobertura do catálogo; no hospedado sem estado de credencial do dono |
| 16 | `odc_portal_capabilities` | servidor | nunca | odc | inventário |
| 17 | `odc_describe_capability` | servidor | nunca | odc | inventário |
| 18 | `odc_list_apis` | servidor | nunca | odc | catálogo das APIs públicas |
| 19 | `odc_search_operations` | servidor | nunca | odc | idem |
| 20 | `odc_describe_operation` | servidor | nunca | odc | idem |
| 21 | `ssam_friction` | servidor | nunca | nenhuma | fila de fricção DO CLIENTE (`customers/<id>/.local/friction`, sempre nomeada: `SSAM_FRICTION_DIR` do processo nunca junta as filas) |
| 21a | `ssam_grant` | servidor | nunca | nenhuma | concessões permanentes DO CLIENTE em `<ws>/state/grants/standing-grants.json` (interno, fora da área visível). A concessão de um cliente só autoriza `o11_deliver`, `o11_publish` e `studio_deliver publish:true` desse cliente; as do dono nunca valem para um cliente |
| 22 | `ssam_doctor` | agente | relatório (responde sem agente e diz que falta) | nenhuma | estado do agente, versões e Studios do cliente |
| 23 | `studio_doctor` | agente | relatório | odc | idem, lado ODC; nunca dotnet/builds/cofre do dono |
| 24 | `ssam_connect` | agente | sempre | arg `lane` (`arg:none`) | attach nos Studios do cliente com os binários do pacote; sem `lane`, todas as faixas do token (cada Studio listado, sondado e anexado pelo agente) |
| 25 | `studio_attach` | agente | sempre | odc | `odc.attach` |
| 26 | `o11_deliver` | agente | sempre | o11 | CLI `deliver` no servidor; snapshot, refresh, merge e, com `publish:true`, a publicação pelo bridge do cliente via relay; sem `authorize`, só uma concessão DO CLIENTE; job com op `prototype` recusado (`PROTOTYPE_SOURCE_LOCAL`) |
| 27 | `o11_studio` | agente | sempre | o11 | comandos do bridge |
| 28 | `o11_publish` | agente | sempre | o11 | 1-Click Publish do Studio do cliente |
| 29 | `studio_status` | agente | sempre | odc | bridge |
| 30 | `studio_wait` | agente | sempre | odc | bridge |
| 31 | `studio_assets` | agente | sempre | odc | listagem nativa no Studio; espelha `snapshots/modules.json` |
| 32 | `studio_consumers` | agente | sempre | odc | bridge |
| 33 | `studio_data` | agente | sempre | odc | serviço de dados do Studio |
| 34 | `studio_data_insert` | agente | sempre | odc | idem; arquivo de registros enviado ao agente |
| 35 | `studio_data_update` | agente | sempre | odc | idem |
| 36 | `studio_data_delete` | agente | sempre | odc | idem |
| 37 | `studio_open` | agente | sempre | odc | bridge; `localOml` enviado ao agente |
| 38 | `studio_close` | agente | sempre | odc | bridge |
| 39 | `studio_snapshot` | agente | sempre | odc | captura no cliente, OML espelhado no workspace |
| 40 | `studio_reference_snapshot` | agente | sempre | odc | `.avsig` escrito no cliente e trazido |
| 41 | `studio_latest` | agente | sempre | odc | download nativo no Studio do cliente |
| 42 | `studio_refresh_references` | agente | sempre | odc | bridge |
| 43 | `studio_dismiss_dialog` | agente | sempre | odc | bridge |
| 44 | `studio_check_base` | agente | sempre | odc | pacote do manifesto (4.5) |
| 45 | `studio_preview` | agente | sempre | odc | idem |
| 46 | `studio_merge` | agente | sempre | odc | idem; merge 3 vias com a base que o servidor enviou |
| 47 | `studio_authorize` | agente | sempre | odc | a bridge grava a autorização no manifesto, que volta ao servidor |
| 48 | `studio_publish` | agente | sempre | odc | idem |
| 49 | `studio_create` | agente | sempre | odc | idem |
| 50 | `studio_create_app` | agente | sempre | odc | modelo headless no servidor (evidência em `<ws>/odc/lab/create-app/`); `create-app`, abrir e publicar no Studio do cliente; `authorizationContext` é arquivo do workspace |
| 51 | `studio_command` | agente | sempre | odc | passagem direta; a lista de comandos e a linha final são as do agente (4.8); `portal-private-*`, `portal-api-client-fixture-cleanup` e `portal-upload` são recusados no servidor antes de sair (`HOSTED_STUDIO_SESSION_ONLY`) |
| 51a | `ssam_query_test` | agente | sempre | arg, padrão odc | ODC: o TestQuery nativo do ODC Studio do cliente, com a captura enviada por sha256; O11 recusado no hospedado (a bridge fina não tem teste de query) |
| 52 | `studio_deliver` | agente | sempre | odc | snapshot e merge no cliente; build no servidor; `publish:true` publica no Studio do cliente depois de um merge limpo, com as palavras ou uma concessão DO CLIENTE; job com op `prototype` recusado (`PROTOTYPE_SOURCE_LOCAL`) |
| 53 | `o11_data` | tenant-agente | sempre | o11 | Edit Data pela sessão do Studio do cliente (`data --studio` via relay); o lote com `$ref` é um arquivo de pedido em `<ws>/o11/data/requests`, e `$ref` nomeia registro, nunca caminho |
| 54 | `o11_dependencies` | tenant-agente | `action` em `producers`, `list`, `capture` | o11 | assinaturas pela sessão do Studio (`environment_session`) |
| 55 | `o11_environment` | tenant-agente | `action` diferente de `references` | o11 | `environment_session` no Studio do cliente |
| 56 | `o11_service_center_session` | tenant-agente | sempre | o11 | `sc_session` e a sessão headless `sc_http` (capability `sc_http:studioSession`) do Studio do cliente; cofre, perfil e `credentialTarget` → `HOSTED_STUDIO_SESSION_ONLY`; janela de credencial e `authPrompt` nunca abrem |
| 57 | `o11_service_center_read` | tenant-agente | `action` diferente de `capabilities` e `receipt` | o11 | `sc_api` e `sc_http` no Studio do cliente; `sc_private_http*`, SSO, LifeTime e `timer-events` recusados antes de tentar; registros do `solution-download` em `ws:o11/service-center/downloads` |
| 58 | `o11_service_center_write` | tenant-agente | sempre (preparar, executar e `verify` falam com o host) | o11 | idem; arquivos de valor/.osp/.xif e o `authorizationContext` lidos do workspace no servidor e, para o upload, espelhados no agente (4.6) |
| 59 | `odc_auth_status` | tenant-agente | relatório | odc | sessões do Studio do cliente (`auth-status`); colunas de cofre como "indisponível no hospedado" |
| 60 | `odc_read` | tenant-agente | sempre | odc | `portal-call` no Studio do cliente; o arquivo de pedido nasce em `ws:odc/journal/portal/requests` e o espelho o leva ao agente (nunca a raiz de uma bridge do servidor) |
| 61 | `odc_write` | tenant-agente | sempre | odc | idem; `authorizationContext` é arquivo do workspace |
| 62 | `odc_portal_read` | tenant-agente | sempre | odc | `portal-session fetch` pela sessão headless do ODC Studio do cliente (sem janela); pedido espelhado de `ws:odc/journal/portal/requests` |
| 63 | `odc_portal_write` | tenant-agente | sempre | odc | idem; `portal-credential`, perfis e `portal-private-*` → `HOSTED_STUDIO_SESSION_ONLY` |
| 64 | `odc_portal_login` | tenant-agente | sempre | odc | estado, abertura e fechamento da sessão headless (`portal-session`) no Studio do cliente; `select-profile` e `portal-credential` → `HOSTED_STUDIO_SESSION_ONLY` |
| 65 | `odc_portal_routes` | tenant-agente | sempre | odc | GETs pela sessão headless do Portal no Studio |
| 66 | `odc_operation_status` | tenant-agente | sempre | odc | idem |
| 67 | `odc_deploy` | tenant-agente | sempre | odc | idem; `authorizationContext` é arquivo do workspace |
| 68 | `odc_configurations` | tenant-agente | sempre | odc | idem; segredo (`vaultSettings`, `vaultConfigurations`, inclusive o escopo `mobile-extensibility`) só do cofre DO CLIENTE, lido pela bridge dele; sem prompt e sem cofre do servidor |
| 69 | `odc_asset_delete` | tenant-agente | sempre | odc | idem; `authorizationContext` é arquivo do workspace |
| 70 | `odc_external_db_connection` | tenant-agente | sempre | odc | segredo só se já estiver no cofre DO CLIENTE (lido pela bridge); o prompt para guardar não existe no hospedado |
| 71 | `hybrid_tenants` | tenant-agente | relatório | odc | sessões do Studio do cliente + `<ws>/odc/tenants.json`; nunca o `tenants.json` do dono |
| 72 | `ssam_debug` | indisponível | — | — | publica um wrapper, usa o cofre privado de usuários de app, pipes `ssam-debug-<id>` e hooks locais da máquina do servidor |
| 73 | `ssam_debug_run` | indisponível | — | — | idem |
| 74 | `ssam_debug_invoke` | indisponível | — | — | idem, mais perfis de navegador (CDP) da máquina do servidor |
| 75 | `context` | indisponível | — | — | a sessão controlada exige o hook confiável (UserPromptSubmit/PreToolUse) que emite permissões na máquina do cliente MCP; o servidor não as verifica |
| 76 | `propose` | indisponível | — | — | idem |
| 77 | `continue` | indisponível | — | — | idem |
| 78 | `status` | indisponível | — | — | idem |
| 79 | `ssam_preview` | indisponível | — | — | a prévia local sobe processos e um endereço 127.0.0.1 na máquina do servidor, com perfis preparados nela; o cliente não a veria |
| 80 | `o11_extension` | indisponível | — | — | compila código do cliente na máquina do servidor (motor do Integration Studio), com arquivos da máquina do servidor no spec e pastas de trabalho e recibos compartilhados; ainda sem isolamento por conta |
| 81 | `odc_external_library` | indisponível | — | — | dotnet publish com pacotes NuGet escolhidos no spec roda na máquina do servidor (passos de build de pacote executam código); ainda sem isolamento por conta |
| 82 | `studio_reference_producers` | agente | sempre | odc | comando novo da bridge `reference-producers <Module>` no Studio do cliente; só leitura |
| 83 | `odc_mcp_connection` | tenant-agente | sempre | odc | `portalRead` pela sessão headless do Studio do cliente; `portal-credential` → `HOSTED_STUDIO_SESSION_ONLY` |
| 84 | `odc_mcp_import` | tenant-agente | sempre | odc | `portalWrite` pela mesma sessão, recibo no workspace do cliente; mesmas recusas |
| 85 | `odc_a2a_connection_delete` | tenant-agente | sempre | odc | `portalRead` e `portalWrite` pela sessão do Studio; `authorizationContext` é arquivo do workspace; mesmas recusas |
| 86 | `odc_a2a_connection_plan` | servidor | nunca | odc | preparação pura: não autentica, não chama o endpoint, não reserva recibo |
| 87 | `odc_native_package` | indisponível | — | — | só API Client do cofre do servidor e download para o diário dele; `cause:"API_CLIENT_ONLY"`, continuação para ler o build pela sessão do Studio |
| 88 | `odc_generated_code` | indisponível | — | — | idem; continuação para ler builds e deploys pela sessão do Studio |
| 89 | `odc_asset_source` | indisponível | — | — | idem (`auth` literal `api-client`); continuação para `studio_latest` |
| 90 | `odc_asset_revision` | indisponível | — | — | idem, e ainda tem `file` e `candidateProof` como caminhos; continuação para `studio_deliver` |
| 91 | `ssam_debug_server` | indisponível | — | — | o mesmo motivo do `ssam_debug` |
| 92 | `ssam_debug_client` | indisponível | — | — | idem, mais perfis de navegador (CDP) da máquina do servidor |
| 93 | `ssam_debug_matrix` | indisponível | — | — | lê e grava a evidência de `.local/debugger` da máquina do servidor (do dono) |
| 94 | `ssam_code` | servidor | `arg:odc` | por ação: `read` de um nome de módulo, `plan` e `write` | a8: tudo do workspace do usuário. `read` é o `ssam_map` sobre uma captura do workspace (nome de módulo captura pelo agente); `check` e `plan` leem a captura mais nova de `ws:o11/snapshots` ou `ws:odc/snapshots` (base só dali) e os produtores do workspace, e gravam jobs e planos em `ws:o11/` e `ws:odc/lab/`; `files`, `stubs`, `shared`, `base`, `basedOn.job`, `also[].basedOn.job` e `producers` são entradas do workspace, e os caminhos dentro das ops confinados como os de um job. O plano nomeia os arquivos dos subagentes na caixa de entrada do agente e leva os prompts à máquina do usuário. `write` entrega por `o11_deliver`/`studio_deliver` (o mesmo portão). Uma edição de lógica só expande leitura que este usuário recebeu. Cada `check` toma uma vaga do cliente e uma do servidor, numa fila só, por ordem de chegada (`hosted/checks.mjs`: `SSAM_CODE_CHECKS` e `SSAM_CODE_CHECKS_PER_CUSTOMER`; sem elas, as CPUs do contêiner menos 1, de 1 a 4, e 2 por cliente); o `candidate.oml` e o `work/` do check saem quando ele termina (o `job.json` fica), e os que um check interrompido deixou saem depois de 1 h. Interruptor: a classe; `unavailable` recusa com o bloco `off` (`SSAM_CODE_HOSTED_PENDING`, continuação `ssam_map`) e as instruções da sessão voltam às de antes. (marco-a5: era indisponível, `SSAM_CODE_HOSTED_PENDING`.) |

Notas da tabela:

- Linha 57: `capabilities` e `receipt` respondem do servidor (catálogo e diário do workspace); as demais leituras falam
  com o host. A faixa `hosted` codifica `{when:"not-in", arg:"action", values:["capabilities","receipt"]}`.
- Linhas 56 a 58 (24º): no hospedado o Service Center usa só a sessão do Studio do cliente: `studio` para a API e
  `studio-http` (o `sc_http` headless, capability `sc_http:studioSession`) para as páginas. São recusados antes de
  qualquer tentativa, com `HOSTED_STUDIO_SESSION_ONLY`: `session:"vault"`, `credentialTarget`, os perfis guardados
  (`CredentialProfiles` é nulo no hospedado, e os métodos dele recusam), `sc_private_http*` (no `bridge.mjs` e no
  `AgentExecutor`), o SSO e o protocolo de identidade (`sso.mjs`, `community-identity.mjs`), o LifeTime e o
  `timer-events`. A janela de credencial e o `authPrompt` nunca abrem: onde o fluxo local abriria a janela, a resposta é
  `HOSTED_PROMPT_UNAVAILABLE`. O `hiddenSignIn` do 24º passa pela sessão headless do Studio (sem cofre e sem janela). Os
  registros do `solution-download` ficam em `ws:o11/service-center/downloads` (`<id>.context`, sem PowerShell nem DPAPI
  no servidor, fora do alcance da `ssam_evidence`).
- Linhas 62 a 64 (24º): no hospedado `odc_read`/`odc_write`/`odc_portal_*` com `auth:"api-client"` ou
  `auth:"portal-credential"` são recusados com `HOSTED_STUDIO_SESSION_ONLY`; `auto` = só a sessão headless do Studio
  (`portal-session`, sem janela). `odc_portal_login action:"select-profile"` é recusado do mesmo jeito. O transporte
  privado do Portal (`portal-private-call`, `portal-private-download`, `portal-api-client-fixture-cleanup` e
  `portal-upload`) e os pipes de passagem de sessão nunca são usados: o `AgentExecutor` recusa os comandos antes de
  preparar ou enviar. O `odc3-context.mjs` (conta do Portal do servidor e HTTP direto) recusa no cofre, no broker e no
  contexto. O arquivo de pedido do `portal-call` e do `portal-session fetch` nasce em `ws:odc/journal/portal/requests`
  e o espelho o leva ao agente (risco R4); a raiz da bridge do servidor nunca é consultada.
- No hospedado toda escrita de tenant exige `confirmTenant` dos dois lados: o `<ws>/odc/tenants.json` nasce com
  `default:null`, e a bridge do cliente, sem `tenants.json` na raiz dela (`PortalCommands.cs:25`), também trata todo
  host como não padrão (`PortalCore.cs:162-165`). Um tenant padrão por cliente é a pergunta 12.

Formato de `platforms/odc/facade/hosted/tools.json` (faixa `hosted`):

```json
{ "schema": "ssam-hosted-tools/1",
  "tools": {
    "ssam_map": { "class": "server", "lane": "arg:odc", "agent": { "when": "module-target", "arg": "target" },
                  "paths": { "in": ["/target"], "out": [] }, "reason": "..." },
    "studio_build": { "class": "server", "lane": "odc", "agent": "never",
                      "paths": { "in": ["/base", "/producer"], "out": ["/output"] }, "reason": "..." },
    "studio_merge": { "class": "agent", "lane": "odc", "agent": "always", "paths": { "in": ["/manifest"], "out": [] }, "reason": "..." },
    "ssam_debug": { "class": "unavailable", "lane": "none", "agent": "never", "paths": { "in": [], "out": [] }, "reason": "..." } } }
```

`agent`: `"always"` | `"never"` | `"report"` | `{when:"module-target", arg}` | `{when:"present", arg}` |
`{when:"non-empty", arg}` | `{when:"in", arg, values}` | `{when:"not-in", arg, values}` | `{when:"absent-all", args}`.
`lane`: `"o11"` | `"odc"` | `"none"` | `"arg:<padrão>"`, onde o padrão pode ser `none` (`ssam_connect`: com `lane`, as
conferências daquela faixa; sem `lane`, só as do agente).

## 6. Workspace por cliente e confinamento de caminhos

### 6.1 No servidor

```
.local/server/customers/<tokenId>/
  odc/        raiz de DADOS ODC do cliente (SSAM_HYBRID_ODC_ROOT dos processos hospedados; espelho de agent:odc/):
              tenants.json, snapshots/, journal/ (staging/, data/, portal/, inspect/), lab/, .local/jobs/inline/, tmp/
  o11/        "lane local" O11 do cliente (espelho de agent:o11/): snapshots/, jobs/, work/, journal/ (staging/),
              environment/, data/, access/, tasks/, downloads/, service-center/receipts/, inventory.json, tmp/
  inbox/      cópias de arquivos que o cliente pôs em agent:inbox/
  state/      interno: relay-authority/bridge.key, transfers/, locks/, service-center/
  .local/friction/   fila de fricção do cliente
```

- A chave é o `tokenId` (`tok_...`). Um token reemitido ganha outro workspace (pergunta aberta 2).
- Área visível ao LLM: `odc/`, `o11/` e `inbox/` (qualquer profundidade). `state/` e `.local/` são internos: nenhum
  caminho `ws:` os alcança e `fromAgent` também não.
- No hospedado, TODA escrita de dados da fachada vai para o workspace (faixa `seam`, regra das raízes de 4.1). Tabela
  completa (de → para):

| Hoje (local) | Hospedado |
|---|---|
| dados ODC de `lib.mjs` (`platforms/odc`: `tenants.json`, `snapshots/`, `journal/`, `lab/`, `journal/inspect/`, `journal/data/requests/`, `journal/portal/requests\|receipts/`) | `<ws>/odc/...` (mesmos nomes) |
| `<raiz ODC>/.local/jobs/inline` (`ssam.mjs:330/335`) | `<ws>/odc/.local/jobs/inline` |
| `<raiz ODC>/.local/journal` (diário do patch, `ssam.mjs:331`) | `<ws>/odc/journal` |
| `anvilRoot/.local/lane-odc/create-app/<stamp>` e `.../journal/studio_create_app.jsonl` (`studio-create-app.mjs:115-128/168`) | `<ws>/odc/lab/create-app/<stamp>` e `<ws>/odc/journal/studio_create_app.jsonl` |
| `anvilRoot/.local/lane-odc` como pasta local de jobs e diário (`job-runner.mjs:100`, `ssam-reference.mjs:172`) | `<ws>/odc/.local` (o `cli/anvil-odc.dll` continua no servidor) |
| `o11LaneOf().local` (`anvilRoot/.local` ou `.local/lane-ss5`: jobs, work, proofs, data, environment, journal, access, `inventory.json`) | `<ws>/o11` (o `cli` continua no servidor) |
| `anvilRoot/.local/tasks` (`ssam-task.mjs:14`) | `<ws>/o11/tasks` |
| travas de escrita do Studio (`studio-write-lock.mjs`) | `<ws>/state/locks` |
| recibos do Service Center (`%USERPROFILE%/.ssam-hybrid/o11/service-center/receipts`, `service-center/index.mjs:91-94`) | `<ws>/o11/service-center/receipts` (o `main()` recebe `deps.journal`) |
| estado do Service Center (`%USERPROFILE%/.ssam-hybrid`, `service-center/auth.mjs:26`) e exportações | `<ws>/state/service-center` e `<ws>/o11/service-center/` |
| catálogos de `lanes.mjs` (`LANES.*.catalog`) | `<ws>/o11/inventory.json`, `<ws>/odc/snapshots/modules.json` |
| `TEMP`/`TMP` e `cwd` dos processos do kernel e do builder | `<ws>/<faixa>/tmp` e `<ws>/<faixa>` (4.7) |
| `anvilRoot/.local/connections/<lane>.json` | não usado (registro do executor, 4.7) |
| respostas paginadas (`anvilRoot/.local/answers`, nona entrega) | `<ws>/o11/answers` (lidas pelo `ssam_evidence` do mesmo cliente) |
| concessões permanentes (`<workspaceRoot>/.local/grants/standing-grants.json`) | `<ws>/state/grants/standing-grants.json` |
| cache de entrega ODC (`<raiz ODC>/.local/deliver-cache`) | `<ws>/odc/.local/deliver-cache` (o builder que entra na chave continua no servidor) |
| comando em curso por Studio (`lib.mjs inFlight`, `studio_status` com a bridge ocupada) | um registro por executor; o `lab` lido é `<ws>/odc/lab` |

- Compartilhado entre clientes, de propósito: o leitor residente e o índice de módulos, chaveados pelo sha256 dos bytes
  da captura (nenhuma ferramenta lista esse índice; só acha quem tem os mesmos bytes). E o índice do discover (fontes do
  kernel, não dados do cliente).
- Sem `tenants.json` com autor, um módulo NOVO pelo builder (`studio_build newModule`) não tem autor e é recusado pelo
  próprio builder (`Program.cs:227`); módulos existentes tiram tenant e autor do `.json` da captura do cliente. Apps e
  bibliotecas novas vão por `studio_create_app`, que usa o usuário da sessão do Studio.
- Cota: 5 GiB por workspace. O uso é medido por uma varredura guardada por 60 s, somada aos bytes recebidos depois dela.
  Acima da cota, o portão recusa com `WORKSPACE_FULL` toda ferramenta com ponteiro de saída (6.4) ou que precise do
  agente (exceto as de relatório), e `receiveBlob` recusa uma vinda que passaria da cota.

### 6.2 No agente

```
<agentRoot>  (padrão %USERPROFILE%\SSAM-Agent; o zip é extraído aqui)
  agent\                         código do agente (ssam-agent.mjs, lib\)
  bin\o11\connect\               Anvil.Connect.dll (+ dependências)
  bin\o11\hook\                  Anvil.RuntimeHook.Agent.dll
  bin\o11\bridge\                Anvil.Bridge.dll (a bridge fina, sem o kernel) [+ Anvil.Bridge.deps.json] e nada mais,
                                 compilada para o Service Studio do kernel (O11-BRIDGE-FINA.md §6.1)
  agent\node\                    node.exe + LICENSE, por padrão (O11-BRIDGE-FINA.md §6.3)
  docs\AGENTE-CLIENTE.md         o guia do cliente, em inglês (o agente, o ssam-agent.ps1 e as dicas do servidor citam
                                 este caminho; desde server/english-agent, 15/10/2026)
  odc\README.md                  marcador da raiz da bridge ODC
  odc\studio\bridge\bin\Release\net8.0\ODC3.Bridge.v35.dll
  odc\studio\bridge\client\bin\Release\net10.0\ODC3.Bridge.Client.dll (+ deps, runtimeconfig)
  odc\snapshots\  odc\journal\ (staging\)  odc\lab\          dados (espelho)
  o11\ (journal\staging\, downloads\, ...)                 dados (espelho)
  inbox\                                                   arquivos que o cliente entrega ao servidor
  private\  config.json, credential, authority\bridge.key, o11-connection.json, runtime-connect\, agent.log
  pack.json                                                id, faixas, versões e sha256 de cada arquivo do pacote
```

- Raiz fora de `%LOCALAPPDATA%`: processos MSIX (o app do Claude, por exemplo) veem um `%LOCALAPPDATA%` privado, e o
  Studio não acharia a DLL passada no attach; o código já evita essa pasta (`service-center/auth.mjs:25`,
  `service-center/index.mjs:88`).
- A raiz não pode ter espaço nem outro branco: a bridge ODC divide os argumentos por espaços. `setup` recusa e pede
  `--root` (exemplo: `C:\SSAM-Agent`).
- `setup` restringe `private\` ao usuário atual:
  `icacls <agentRoot>\private /inheritance:r /grant:r "<DOMÍNIO\usuário>:(OI)(CI)F"`.

Pastas que o servidor pode tocar (todo o resto: `PATH_FORBIDDEN`):

| Operação | Prefixos permitidos (relativos a `<agentRoot>`) |
|---|---|
| gravar (`file.put`, saídas da bridge) | `odc/snapshots/`, `odc/journal/`, `odc/lab/`, `o11/` |
| ler (`file.get`, `file.list`, entradas da bridge) | os mesmos + `inbox/` |

Normalização no agente antes de qualquer acesso: recusa segmento `..` ou `.`, caminho absoluto, letra de unidade, UNC,
`:` (fluxo alternativo), NUL, nomes de dispositivo (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, com ou
sem extensão), segmento que termina em ponto ou espaço; o caminho real (`realpath`) tem de continuar dentro do prefixo
(link simbólico ou junção que escapa é recusado). `bin/`, `agent/`, `private/`, `odc/studio/`, `odc/README.md`,
`pack.json` nunca são graváveis nem legíveis pelo servidor.

**`fromAgent(value)`** (`hosted/mirror.mjs`, faixa `hosted`) é a única porta de entrada, no servidor, de um caminho que
veio do agente:

- aceita só `agent:<rel>`, com `/` ou `\` como separador;
- aplica a mesma normalização do agente (lista acima) e exige `<rel>` dentro das pastas que o agente pode nomear (a
  tabela acima: `odc/snapshots/`, `odc/journal/`, `odc/lab/`, `o11/`, `inbox/`); o resto da área visível
  (`odc/tenants.json`, `odc/tmp/`, ...) é do servidor e nunca vem do agente de verdade. Um `agent:` que o LLM passa segue
  a mesma regra no portão (`PATH_OUTSIDE_WORKSPACE`, sem culpar o agente);
- exige o `realpath` do ancestral existente mais próximo do destino dentro do `realpath` do workspace;
- devolve `<ws>/<rel>` absoluto.

Violação → `AGENT_PROTOCOL_VIOLATION`: nada é gravado nem lido, `link.protocolError(message)` fecha o canal com
`Close {reason:"protocol-error"}` e a chamada falha (resultado desconhecido quando já foi entregue). Vale para os textos
que o agente diz ter trocado (`paths` das respostas de `odc.pipe`/`o11.bridge`, 4.4), para os campos que o servidor lê
como arquivo (`path` de `snapshot`/`latest` ODC, `data.path` de `snapshot_module` e `data.value.FilePath` de `download`,
que TÊM de ser `agent:`), para as entradas de `file.list`, para `valueBlob` e para todo destino de `receiveBlob`. Um
texto de dado que só começa com `agent:` (fora de `paths`) não é caminho: passa intacto e não fecha o canal. Sem isso, um agente modificado devolveria `agent:..\..\..\.local\server\tokens.json` ou um caminho no
workspace de outro cliente, e `receiveBlob` sobrescreveria arquivos do dono ou o servidor os leria
(`kernel-delivery.mjs:20` lê `snapshot.path`; o `inspect` lê o alvo).

### 6.3 Nomes de caminho que o LLM vê e passa

| Forma | Significado | Uso |
|---|---|---|
| `ws:<rel>` | arquivo da área visível do workspace (`<rel>` começa com `odc/`, `o11/` ou `inbox/`) | o que as ferramentas devolvem e o que o LLM passa de volta |
| `agent:<rel>` | arquivo do workspace do agente | o LLM só passa `agent:inbox/<arquivo>` para entregar um arquivo do cliente |
| relativo, em ponteiro de entrada | `ws:<faixa>/<rel>` (faixa da ferramenta: `odc` ou `o11`) | `base`, `job`, `oml`, ... |
| relativo, em ponteiro de saída | ODC: `ws:odc/lab/<rel>`; O11: `ws:o11/<rel>` | `output`, `out` (6.4) |
| absoluto | aceito só dentro da área visível; senão `PATH_OUTSIDE_WORKSPACE` | — |

Regras da faixa `hosted` (em `hosted/policy.mjs`):

1. Antes de chamar o handler, cada ponteiro da tabela 6.4 é resolvido. `agent:inbox/<rel>` é trazido com `file.get`
   para `<ws>/inbox/<rel>` (destino por `fromAgent`); ao ser enviado de volta a uma bridge, o espelho o copia para
   `journal/staging` (4.5, regra 2). `agent:odc|o11/<rel>` é trazido se faltar no espelho.
2. Um caminho resolvido fora da área visível é recusado antes do handler:
   `{ok:false, code:"PATH_OUTSIDE_WORKSPACE", error, continuation}`.
3. "Parece caminho" = começa com `ws:` ou `agent:`, ou é absoluto, ou termina em `.oml`, `.json`, `.jsonl` ou `.avsig`.
   Nos argumentos que aceitam módulo OU caminho (`target`, `app`), um valor que não parece caminho é nome de módulo.
4. Depois do handler, a resposta é apresentada: em `structuredContent` (em profundidade) e em `content[].text`, todo
   caminho absoluto dentro do workspace vira `ws:<rel>`; qualquer outro caminho sob a raiz do repositório do servidor ou
   sob o perfil do usuário do servidor vira `<servidor>`. Quando o texto é o JSON do `structuredContent`, ele é
   reserializado a partir do objeto apresentado; senão trocam-se as duas formas (crua e com barras escapadas do JSON).
5. Os caminhos DENTRO de um job também ficam no workspace (`hosted/job-paths.mjs`, `servidor/fase4-24`): `base`, as
   partes de um job composto (`jobs[i]`, caminho ou `job:<nome>`), o `producer` de um `reference`, o `file` de um
   `html`, o `data.source` e o `data.capture` de um `prototype`, o `data.wsdl` de um `soap` (e os `imports`) e o
   `data.openapi.path` de um `rest` (e os `external`). Valem no job inline (objeto ou texto), num arquivo de job do
   workspace, em cada parte e alvo `job:<nome>` que ele alcança e no job que um `patch` ou um job parcial produz sobre
   `basedOn`. Inline, cada caminho é reescrito para o caminho absoluto do workspace (`ws:`, `agent:` com a regra do
   espelho, absoluto dentro da área visível, ou relativo sob `ws:<faixa>/`). Num arquivo, nada é reescrito: um nome
   relativo só vale onde o kernel procura primeiro na pasta do próprio arquivo (parte, `job:<nome>`, documento
   WSDL/OpenAPI) e o arquivo está lá. Não são caminhos: nome de binding, URL `http(s)` de documento e as fixtures de
   produto pelo nome da suíte (`tests/fixtures/[odc/]blank-*.oml`, `odc/insurance-reactive-r8.oml`,
   `reactive-ui.oml`, `traditional-ui.oml`, `mobile-ui.oml`). Fora disso: `PATH_OUTSIDE_WORKSPACE` com o `pointer` do
   job (ex.: `/job/ops/2/file`, ou `/job/jobs/0 > /ops/1/file` dentro de uma parte), antes de qualquer leitura. A recusa
   do op `prototype` (D2) continua vindo primeiro.
6. Um arquivo de job que a chamada alcança (o job, o job de `basedOn`, uma parte, um alvo `job:<nome>` de `base` ou
   `producer`) e que existe, mas que o portão não lê inteiro como o kernel lê, é recusado com `JOB_PATHS_UNCHECKED`
   (com o `pointer` e um `fix`), seja qual for o campo: o `File.ReadAllText` do kernel aceita a marca de ordem de bytes
   UTF-8, UTF-16 LE/BE e UTF-32, então o portão decodifica UTF-8 e UTF-16 do mesmo jeito (estrito) e recusa UTF-32, uma
   sequência de bytes inválida, um texto que não é JSON e uma chave repetida no mesmo objeto (o `JSON.parse` fica com o
   último valor; outro leitor pode não ficar). Um arquivo que não existe continua sendo a resposta da própria ferramenta.
7. Os documentos de integração (`soap`, `rest`) lidos para um cliente hospedado (`integration-documents.mjs`, depois do
   portão, em `ssam_job`/`o11_job`, `studio_deliver` e `o11_deliver`): todo arquivo LOCAL que a fixação vai ler, o
   documento e cada import/`$ref` escrito DENTRO dele (absoluto, `file:` ou relativo ao documento), fica na área visível
   do workspace pelo caminho léxico e pelo real (os bytes vêm do caminho real); um documento lido por URL só nomeia URLs
   (nome relativo resolve contra a URL; `file:` ou letra de unidade é recusado); um documento relativo que a pasta do job
   não tem é recusado (o kernel o procuraria no repositório). Fora disso: `PATH_OUTSIDE_WORKSPACE` com o ponteiro do job
   (`/ops/0/data/wsdl`) e a referência, sem ler nada. Toda URL (o documento, cada salto de redirecionamento, cada import)
   tem de chegar a um endereço público (`hosted/public-fetch.mjs`): loopback, rede privada, link-local, faixas reservadas
   e os endereços de metadados de nuvem dão `DOCUMENT_HOST_NOT_PUBLIC`, verificado antes do pedido e de novo na conexão
   (DNS rebinding); o cliente nunca segue um redirecionamento sozinho. A cópia do job que a fixação grava em outra pasta
   continua nomeando, a partir da pasta do job, a `base` e os `producer` `job:<nome>` e os documentos dos outros ops; e um
   import fixado nunca é gravado fora de `<localRoot>/documents/<sha256>/`.

### 6.4 Argumentos de caminho por ferramenta

| Ferramenta | Entrada (`in`) | Saída (`out`) |
|---|---|---|
| `o11_data` | `/oml` | — |
| `o11_service_center_write` | `/valueFile`, `/ospFile`, `/xifFile` | — |
| `o11_dependencies` | `/oml` | `/out` |
| `o11_inspect` | `/oml` | — |
| `o11_deliver` | `/job` (quando texto), `/producers/*`, `/basedOn/job` | — |
| `o11_studio` | — | `/args/path` |
| `o11_environment` | `/oml` | `/out` |
| `o11_job`, `ssam_job` | `/job` (quando texto), `/base`, `/producers/*`, `/basedOn/job` | `/out` |
| `o11_access` | `/manifestPath` | — |
| `ssam_reference` | `/query` quando `kind` é `check-job` ou `check-delivery` e o valor é texto | — |
| `ssam_evidence` | `/file` | — |
| `ssam_discover` | `/app` (quando parece caminho) | — |
| `ssam_map`, `studio_inspect` | `/target` (quando parece caminho) | — |
| `studio_open` | `/localOml` | — |
| `studio_reference_snapshot` | — | `/output` |
| `studio_build` | `/base`, `/producer` | `/output` |
| `studio_manifest` | `/base`, `/candidate` | `/output` |
| `studio_deliver` | `/job` (quando texto), `/producer`, `/basedOn/job` | `/output` |
| `studio_check_base`, `studio_preview`, `studio_merge`, `studio_authorize`, `studio_publish`, `studio_create` | `/manifest` | — |
| `studio_create_app` | `/icon`, `/authorizationContext` | — |
| `studio_command` | `/args/*` (cada um que parecer caminho) | — |
| `o11_service_center_write`, `odc_write`, `odc_portal_write`, `odc_deploy`, `odc_configurations`, `odc_asset_delete`, `odc_external_db_connection`, `odc_a2a_connection_delete` | `/authorizationContext` (24º) | — |

- `/basedOn/job` entrou porque `job-patch.mjs:226` lê esse caminho (relativo à raiz, quando não é absoluto) e hoje ele
  não é confinado.
- 24º: os ponteiros valem sobre os argumentos que a ferramenta roda (`argsOf` da camada de entrada), não só sobre os
  enviados. `{targt}` é confinado como `/target`; um nome que a camada não corrige com certeza (`{fiel}`) é recusado por
  ela (`INPUT_INVALID`) e nada roda.
- 24º: o arquivo de proposta citado dentro de um `authorizationContext` tem de estar na área visível do workspace
  (`ws:<rel>` ou caminho absoluto dentro dela); o resto é recusado como `AUTHORIZATION_CONTEXT_INVALID`.
- `o11_service_center_read` `/path` é caminho de página do Service Center, não arquivo: não entra. As ferramentas
  indisponíveis não entram.
- Gramática dos ponteiros (para `hosted-tools.test.mjs`): segmentos de JSON Pointer; `*` = toda chave de um objeto ou
  todo item de um array. Um ponteiro existe no schema quando cada segmento nomeado está em `properties` (em qualquer
  alternativa de `anyOf`/`oneOf`) ou o pai é um registro (`additionalProperties`, como `o11_studio` `args`); `*` exige
  `items` ou `additionalProperties` no pai (`studio_command` `/args/*`, `/producers/*`).

## 7. Versões do Studio

- O servidor conhece o kernel que tem: `kernel = { o11, odc, odcBridge }` (desde A-M1, também `builds` e
  `studioBuildPolicy`, abaixo).
  - `o11` = `ProductVersion` de `ServiceStudio.exe` na pasta do Studio do kernel (`o11LaneOf().studioDir`).
  - `odc` = `ProductVersion` de `ODCStudio.exe` em `odcStudioDir()`.
  - `odcBridge` = a versão da bridge ODC do servidor (`signedRuntime(root)?.version ?? newestBridgeDll()?.version`).
  - Detectado ao iniciar (`runServed`, faixa `hosted`, com `fileVersion` da faixa `seam`). `.local/server/kernel.json`
    (`{o11, odc, odcBridge}`) sobrepõe quando a detecção falha ou o dono quer fixar.
- O agente informa no `Hello` (e em `pong.versions` quando muda) a versão instalada de cada Studio, e `studio.processes`
  traz a versão de cada processo.
- Regra de compatibilidade (no hub, faixa `hub`): por faixa, `ok` quando a faixa está no token e no pacote, o kernel tem
  versão, e o servidor atende o Studio do cliente (identidade pelo build, abaixo). ODC também exige
  `pack.odcBridge === kernel.odcBridge`; O11 também exige `pack.o11BuiltFor` igual ao kernel (a bridge O11 do pacote foi
  compilada contra aquele Service Studio).
- O agente confere também o PROCESSO escolhido (4.8), mas só os 3 números: o agente 0.3.1 deixa passar outro build da
  mesma versão. Quem julga o build é o servidor, em dois lugares (rodada 2 da revisão, A1):
  - o hub julga o Studio **instalado em disco** (`Hello` e `pong.versions`). O agente relê o disco a cada 5 min, e um
    `pong` perdido nunca é reenviado: logo depois de uma atualização do Studio, por 15 a 315 s, ou até o agente
    reconectar se o `pong` se perder, o hub ainda tem o build velho;
  - por isso, em cada chamada, o servidor julga também o **processo** que vai rodar, com a mesma regra e a mesma recusa:
    no ODC o `AgentExecutor` acha o pid da chamada (`odc.pipe`, `odc.attach`) na lista `studio.processes` do agente, que
    já traz a versão de cada processo; no O11 o portão julga o `studioVersion` do registro do Service Studio conectado
    (`o11.connect`/`o11.selected`). Vale o pior dos dois veredictos. Um pid que o agente não lista, ou um registro O11 sem
    versão, fica só com o veredicto do hub; um processo ODC listado sem versão é recusado (`STUDIO_VERSION_UNKNOWN`), como
    o próprio agente já recusaria;
  - o próprio `o11.connect` (rodada 3, B1) é julgado pelo processo que ele anexa, como o `odc.attach`: o pid pedido ou,
    sem pid, o único Service Studio listado. No `ssam_connect`, o julgamento vem antes de qualquer chamada à bridge (a
    sonda `ping` incluída): um build que o servidor não atende não recebe nada, e a resposta é a recusa (ou
    `studioSkipped`, ao lado das faixas que conectaram). Depois do manipulador do `ssam_connect`, o registro novo da
    conexão também é julgado: outro build atendido traz `studioBuildDiffers`.
- **Identidade pelo build (A-M1, `C:\t\multiver\minimo\PROPOSTA.md`; `studio-identity.mjs`).** Uma regra só, lida pelo
  hub, pelo portão hospedado e pelos eventos:
  - O Studio do cliente é o `ProductVersion` do `.exe` que o agente manda no `Hello` (e no `pong.versions`), com 4 números
    (`1.7.28.10873`). O do servidor é `kernel.builds[faixa]`: a `FileVersion` do `ServiceStudio.Framework.dll` da pasta do
    Studio da imagem (`kernel-image.mjs servedBuilds`); fora da imagem, o `.exe` desta máquina. Servidor que não sabe o
    próprio build compara 3 números, como antes. O início registra `studio-builds` (os builds e a política por faixa); o
    evento `kernel` mantém o formato.
  - Outra versão de 3 números nunca é atendida, antes de conferir o pacote: Studio mais velho → `cause:
    "STUDIO_UPDATE_REQUIRED"` (atualize o Studio); mais novo → `cause: "STUDIO_VERSION_NOT_SERVED_YET"` (o servidor ainda
    não tem; o dono foi avisado; não volte o Studio). O código continua `STUDIO_VERSION_MISMATCH`.
  - Mesmos 3 números e outro build (ou versão sem o 4º número): decide `kernel.json` `studioBuildPolicy`, uma palavra para
    as duas faixas ou `{"odc": ..., "o11": ...}`. `"warn"` (padrão, opção D-M2a do dono): atende, e toda resposta da faixa
    traz `studioWarning` `studioBuildDiffers`. `"refuse"` (D-M2b): recusa como outra versão, pela direção (versão sem o
    build: `STUDIO_BUILD_UNKNOWN`). Valor desconhecido recusa (falha fechada) e o início marca `policyInvalid`.
  - Versão que o agente não leu: `STUDIO_VERSION_UNKNOWN`, depois das conferências do pacote, como antes.
- Recusa (faixa `hosted`, antes do handler, só para ferramentas que precisam do agente naquela faixa): UMA resposta com
  tudo. A direção (`cause`), os dois builds (`installed`, `served`), o que continua funcionando (`stillWorks`: as
  ferramentas só de servidor da faixa, de `hosted/tools.json`), `outcome: "not-sent"` e "nada rodou". `userMessage` para
  o usuário e `error` para o modelo, dois textos, os dois em inglês (rodada 3, B3: regra do dono de 15/10, todo texto que
  o SSAM emite em inglês, sem linha bilíngue). A continuação antiga ("instale o Studio na versão do servidor", impossível
  no ODC) saiu:

```json
{ "ok": false, "code": "STUDIO_VERSION_MISMATCH", "cause": "STUDIO_VERSION_NOT_SERVED_YET", "lane": "odc",
  "installed": "1.7.29.10900", "served": ["1.7.28.10850"], "relation": "newer", "policy": "warn", "outcome": "not-sent",
  "stillWorks": ["ssam_discover", "ssam_map", "ssam_reference", "ssam_job", "studio_build", "odc_search_operations", "..."],
  "error": "This SSAM server serves ODC Studio 1.7.28.10850; the user's machine has ODC Studio 1.7.29.10900, which is newer: the server does not serve this version yet; the owner was notified (server event studio-version-unserved). Do not roll the Studio back and do not reinstall the agent; repeat the call once the server is updated. Nothing ran on the user's Studio. Server-only tools (...) still work, with the studioNotServed warning.",
  "userMessage": "The ODC Studio on this computer (1.7.29.10900) is newer than the ODC Studio the SSAM server serves today (1.7.28.10850). The server does not have this version yet; the SSAM owner was already notified (the server recorded this request). Do not roll ODC Studio back to the previous version and do not reinstall the agent: once the server is updated, repeat the request. Nothing ran on your Studio. Meanwhile, the server-only tools (...) keep working, with a warning.",
  "serverKernel": "1.7.28", "agentStudio": "1.7.29.10900",
  "continuation": { "tool": "ssam_doctor", "arguments": {}, "why": "Show the user the userMessage as it is: nothing to do on their machine until the server owner updates the server; never ask the user to roll the Studio back or to reinstall the agent. ..." } }
```

- Avisos nas respostas que rodaram (campo `studioWarning`, ao lado dos campos da ferramenta): `studioBuildDiffers` em toda
  resposta da faixa quando o servidor atende outro build com `"warn"`; `studioNotServed` quando uma ferramenta só de
  servidor (ou um relatório de estado) roda enquanto o Studio da faixa não é atendido (E2: antes respondia calada com o
  kernel do servidor). Com mais de uma faixa, `studioWarning` é o primeiro e `studioWarnings` traz todos.
- Ferramentas da faixa `none` (rodada 2, A2) passam pela identidade de cada faixa que tocam: `ssam_task` conta como O11
  (o `close` roda o kernel O11 contra o Service Studio); as outras, todas as faixas do token. `ssam_connect` sem `lane`
  conecta só as faixas atendidas e devolve as puladas em `studioSkipped` (a recusa inteira de cada uma); sem nenhuma
  atendida, é uma recusa só, com `lanes`. Uma chamada do Studio recusada pelo processo, numa ferramenta que já mandou
  outra chamada ao Studio ou num relatório de estado, também volta em `studioSkipped`; sem nenhuma chamada enviada, a
  resposta é a própria recusa.
- Log (E1): `agent-connected` grava `studios` (só os números de versão de cada Studio instalado, nunca a pasta). Novo
  evento `studio-version-unserved` {`token` (o id `tok_…`), `lane`, `installed`, `served`, `relation`, `cause`,
  `policy`}: uma vez por acesso, faixa e versões, quando o hub julga o `Hello` ou um `pong.versions`, ou quando o
  servidor recusa o processo de uma chamada (a mesma chave: um evento só). Repete depois de um reinício do servidor.
- `AGENT_PACK_MISMATCH` usa o formato antigo, com `why` "ask the server owner for the current agent package".
- Um único kernel por faixa no servidor: o limite está na seção 11.
- Imagem interina (desenho de várias versões, O.6.1; `kernel-image.mjs`). A imagem declara as versões que serve:
  `ENV SSAM_IMAGE_O11` e `SSAM_IMAGE_ODC`, rótulos `ssam.kernels.o11` e `ssam.kernels.odc`. O build confere essas versões
  contra o `ServiceStudio.Framework.dll` de cada pasta do Studio.
  - Faixa cujo `kernel.json` nomeia outra versão fica desligada ao iniciar: `KERNEL_UNAVAILABLE` com
    `cause: "KERNEL_VERSION_MISSING"`, e o servidor registra `kernel-version-missing`. O kernel da imagem nunca roda contra
    outro Studio. O evento `kernel` mantém o formato (a faixa desligada vem `null`). A recusa vale também para as
    ferramentas só do servidor dessa faixa (`ssam_job`, `ssam_map`, `ssam_discover`, `ssam_reference`, `o11_job`,
    `odc_search_operations`), no portão hospedado; só `ssam_doctor` e `studio_doctor` respondem. O aquecimento pula a faixa.
  - Studio do cliente MAIS VELHO que a versão do servidor (Service Studio 11.55.91 no servidor 11.55.92):
    `STUDIO_VERSION_MISMATCH` com `cause: "STUDIO_UPDATE_REQUIRED"` (até A-M1, `"STUDIO_VERSION_NOT_SERVED"`), `served` e
    `installed` (agora a versão inteira que o agente manda), antes de conferir o pacote. Nenhum pacote resolve. Studio mais
    novo: `cause: "STUDIO_VERSION_NOT_SERVED_YET"` (até A-M1, sem `cause`).
  - Só `kernel.json` v1. Um `kernel.v2.json` ao lado é ignorado (`kernel-v2-ignored`); um `kernel.json` no formato v2 não
    serve faixa nenhuma (`kernel-json-unsupported`).
  - Os caches sem versão do Studio (índice de módulos `v1/<faixa>`, cópias dos leitores O11 e do prefetch) são esvaziados
    quando a versão da faixa muda (`kernel-cache-reset`; carimbo `kernel-studio.json` na raiz do índice). Faixa desligada
    conta como carimbo inválido: as raízes dela são esvaziadas e o carimbo dela sai.

## 8. Sem agente, sem conexão O11, contexto perdido

Antes do handler, para ferramentas cuja regra pede o agente (seção 5) quando `link.connected()` é falso:

```json
{ "ok": false, "code": "AGENT_NOT_CONNECTED",
  "error": "The SSAM agent of this account is not connected, so nothing ran on the user's machine.",
  "continuation": { "tool": "ssam_doctor", "arguments": {},
    "why": "Ask the user to start the SSAM agent on their machine (agent\\ssam-agent.ps1 start, see docs/AGENTE-CLIENTE.md), then call this tool again. ssam_doctor shows when the agent is connected." } }
```

- `ssam_doctor`, `studio_doctor`, `odc_auth_status` e `hybrid_tenants` (regra `report`) respondem mesmo sem agente,
  com `agent: {connected:false, ...}` e a mesma continuação.
- Se o agente cair DURANTE uma chamada, vale a seção 4.3 (não entregue = nada aconteceu; entregue = incerto, nunca
  repetido).
- Token sem credencial de agente (emitido na fase 1; `link.info().credential === false`): mesmo código, com `why`
  "the server owner must issue an agent credential for this token (ssam server-token agent-rotate)".

Ferramenta da faixa o11 que pede o agente, com agente conectado mas sem registro O11 (`executor.o11Connection()` nulo):

```json
{ "ok": false, "code": "O11_NOT_CONNECTED",
  "error": "No Service Studio of this account is connected to SSAM, so nothing ran on the O11 lane. The server never falls back to another Studio.",
  "continuation": { "tool": "ssam_connect", "arguments": { "lane": "o11" },
    "why": "Ask the user to open Service Studio (the version ssam_doctor shows), then connect it and call this tool again." } }
```

Outras recusas do portão, no mesmo formato `{ok:false, code, error, continuation}`:

- `HOSTED_UNAVAILABLE`: `error` com o motivo da tabela; `continuation` = `ssam_discover {intent:<o pedido>}`.
- `HOSTED_LANE_DISABLED`: a faixa da ferramenta não está em `lanes` do token.
- `WORKSPACE_FULL`: workspace acima da cota (6.1); `continuation` = `ssam_doctor` (mostra o uso).
- `HOSTED_CONTEXT_LOST` (vindo do `DenyExecutor`): erro interno do servidor; nada rodou em máquina nenhuma;
  `continuation` = `ssam_doctor`, `why` "report this to the server owner; do not retry in a loop".

## 9. Operação e exposição

### 9.1 HTTPS para um testador de fora

- `ssam serve` é hospedado por padrão (`agents:{kernel}`, `DenyExecutor` como padrão do processo).
- `ssam serve --local-studios` é o modo da fase 1: as ferramentas dirigem os Studios do PRÓPRIO dono. É só para o dono,
  em loopback: recusa `--public-host` e `--allow-remote` ao iniciar e responde 403 `FORWARDED_REFUSED` a todo pedido
  com `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `CF-Connecting-IP` ou `CF-Ray`. A recusa de cabeçalho é uma
  rede de segurança, não garantia (um nginx sem esses cabeçalhos passaria): **nunca exponha um servidor
  `--local-studios` por túnel ou proxy**. O comando de túnel rápido abaixo reescreve o Host para `127.0.0.1:7300` e
  passaria na verificação de loopback; num servidor `--local-studios`, qualquer token dirigiria os Studios do dono.
- O servidor continua escutando em `127.0.0.1`. Quem expõe é um túnel ou proxy na mesma máquina.
- Recomendado para o primeiro testador: **Cloudflare Tunnel** (`cloudflared`), conexão de saída da máquina do dono,
  sem porta aberta, certificado válido. Teste rápido (só com o servidor hospedado):
  `cloudflared tunnel --url http://127.0.0.1:7300 --http-host-header 127.0.0.1:7300` (URL aleatória
  `*.trycloudflare.com`; o Host reescrito passa na verificação de loopback sem `--public-host`). Estável: túnel nomeado
  com domínio próprio na Cloudflare e `ssam serve --public-host <domínio>`. O dono sobe os dois de uma vez com
  `.\scripts\tunel.ps1 start [--port N]` (servidor hospedado pelo `servidor.ps1`, recusa um servidor `--local-studios`,
  mostra a URL e a configuração do cliente); `status`, `stop [--server]`, `config`, `plan`
  ([O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md) §13.3).
- Alternativa: Caddy (`reverse_proxy 127.0.0.1:7300` com `flush_interval -1`) quando há domínio e porta 443 abertos.
- Proxy não pode bufferizar respostas: o `/mcp` usa SSE e o `/agent/v1/stream` usa NDJSON. Caddy: `flush_interval -1`.
  nginx: `proxy_buffering off`. cloudflared não bufferiza.
- Novo `ssam serve --public-host <nome>` (repetível): acrescenta `<nome>` (e `<nome>:443`) aos Host aceitos e
  `https://<nome>` às Origin aceitas. Continua escutando em loopback. É o jeito certo de atender pelo túnel.
- `--allow-remote` continua existindo só para LIGAR em endereço que não seja loopback (desencorajado; só no hospedado);
  ele não é mais necessário para o túnel.
- Keepalive SSE: em respostas `text/event-stream` do `/mcp`, o servidor escreve `: keepalive\n\n` a cada 25 s sem
  escrita (só em fronteira de evento: o último pedaço terminou em `\n\n`). Evita que túnel/proxy derrube uma chamada
  longa (um `o11_deliver` pode levar até 60 min).
- `/health` passa a responder `{"ok":true,"pid":<pid do processo>}` (usado pelo `servidor.ps1`).
- `--log-file <caminho>`: o servidor grava também nesse arquivo os eventos que hoje vão para a saída padrão.
- Recomendado: rodar o `ssam serve` hospedado numa conta Windows dedicada, sem privilégio. OML e JSON enviados pelo
  cliente são lidos pelas DLLs de modelo do Studio e pelo kernel na sessão de quem roda o servidor; um defeito de
  parser vira acesso àquela conta. Nessa conta: `ANVIL_STUDIO_DIR` apontando para o Service Studio do kernel (o padrão
  é a cópia da faixa sob o perfil do usuário) e a pasta do repositório legível. Pergunta 13.
- Limite conhecido: o tempo de espera do `BridgeClient` do kernel inclui o espelho de arquivos pelo relay (4.6); no
  hospedado ele é de pelo menos 600 s (`ANVIL_BRIDGE_TIMEOUT_SECONDS=600`, [O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md) §4.4).

### 9.2 Correções do `scripts/servidor.ps1`

1. **Sucesso falso com outra porta ocupada.** Antes de iniciar: se `/health` da porta já responde e não há pid próprio
   vivo, recusa com "porta <N> ocupada por outro processo (pid <P>)" e código 1. Durante a espera: só conta como no ar
   quando `/health` devolve `pid` igual ao do processo iniciado; outro pid → para o processo iniciado e sai com 1.
2. **Chamada capturada que nunca volta.** `Start-Process` com `-RedirectStandardOutput/-Error` faz o node herdar os
   handles de quem chamou. Correção: iniciar SEM redirecionamento (`Start-Process -WindowStyle Hidden -PassThru`, que no
   Windows PowerShell usa ShellExecute e não herda handles) e passar `--log-file <dir>\server.log`. Em falha de início,
   a mensagem manda rodar `.\ssam serve` em primeiro plano para ver o erro.
3. **Pid velho reaproveitado por outro node.** O pid de `server.pid` só conta como o servidor quando o processo é um node
   cuja linha de comando tem `ssam.mjs` e o `--log-file` desta pasta. Senão o arquivo é velho: é apagado, `start` sobe
   o próprio servidor (sem "Ja esta rodando" falso), `status` diz parado e `stop` não para nada.

`servidor.ps1 start` sobe o servidor hospedado. Mesmo padrão em `agent\ssam-agent.ps1` (faixa `agent`).

### 9.3 CLI de tokens

```
ssam server-token issue --customer "Cliente X" [--days N] [--lanes odc,o11]   # mostra token E credencial do agente, UMA vez
ssam server-token agent-rotate --id tok_xxxxxxxxxxxx                          # nova credencial do agente; o canal atual fecha em ≤ 1 s (rotated)
ssam server-token list                                                        # + lanes, agent {issuedAt}; nunca segredos
ssam server-token revoke --id tok_xxxxxxxxxxxx                                # derruba MCP e agente
```

- `--lanes` padrão `odc,o11`. Ver o limite de propriedade intelectual do O11 (seção 11 e pergunta aberta 1).
- Nada disso é rota HTTP. A administração continua local, e só o CLI escreve `tokens.json` (2.2).
- Num servidor `--local-studios`, todo token dirige os Studios do dono: emita tokens para ele só para testes do próprio
  dono em loopback.

### 9.4 Pacote do agente (`scripts/agent-pack.ps1`, faixa `agent`)

```
.\scripts\agent-pack.ps1 -Out C:\caminho\ssam-agent.zip [-Lanes odc,o11] [-NodeExe <node.exe>] [-NodeLicense <arquivo>] [-NoNode] [-NoBuild -Prebuilt <pasta>]
```

- Monta a árvore da seção 6.2 numa pasta temporária e compacta (`Compress-Archive`).
- ODC: a bridge e o cliente da seleção assinada (`.local/signed-runtime`) quando existe; senão os de
  `platforms/odc/studio/bridge/.../bin/Release`.
- O11 (só com `o11` em `-Lanes`): compila a bridge fina `kernel\src\Anvil.Bridge.Thin\Anvil.Bridge.Thin.csproj`
  (assembly `Anvil.Bridge`, sem o kernel) com `-p:SSDir=<o11LaneOf().studioDir>`, `Anvil.RuntimeHook` com
  `-p:AssemblyName=Anvil.RuntimeHook.Agent` e `Anvil.Connect`, cada um com `--artifacts-path` dentro da pasta
  temporária. Exige `connect\Anvil.Connect.dll`, `hook\Anvil.RuntimeHook.Agent.dll` e `bridge\Anvil.Bridge.dll`; nenhum
  `Anvil.Core.dll` vai no pacote. O ZIP pronto passa pela varredura de propriedade intelectual
  (`scripts\pack-ip-scan.ps1`, [O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md) §6.4): achado apaga o ZIP e para o script.
- Escreve `pack.json` (`id`, `lanes`, `odcBridge`, `o11BuiltFor`, `files: [{path, sha256, size}]`).
- Nunca inclui: fontes (`.cs`, `.csproj`), outros `.mjs` além de `agent\`, `.local\server`, chaves, credenciais.
- Node por padrão (decidido em 2026-10-05): o `node.exe` de `Get-Node` (ou o de `-NodeExe`) vai para
  `agent\node\node.exe`, sempre com a licença em `agent\node\LICENSE` (`-NodeLicense <arquivo>`; senão `LICENSE` na
  pasta do `node.exe` ou na pasta acima; sem nenhum, o script recusa antes do ZIP). `-NoNode` deixa os dois de fora (o
  cliente precisa então do Node 24). [O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md) §6.3.
- `-NoBuild -Prebuilt <pasta>` usa binários já prontos (é o modo dos testes; nenhum `dotnet build` em teste).

### 9.5 Guia do cliente (`docs/AGENTE-CLIENTE.md`, faixa `agent`)

Em inglês desde 15/10/2026 (regra do dono: todo texto que chega ao licenciado em inglês), e o pacote o leva em
`docs\AGENTE-CLIENTE.md`. As frases da seção "Privacy" são conferidas por `privacy-record.test.mjs` e
`quality-privacy-doc.test.mjs` do servidor.

Pré-requisitos (Windows; o Node vem no pacote, `agent\node\node.exe` com a licença em `agent\node\LICENSE`, e só um
pacote `-NoNode` pede o Node 24 instalado com `--use-env-proxy` e `--use-system-ca`, conferidos pelo `doctor` por
`process.allowedNodeEnvironmentFlags`; .NET 10 runtime para o cliente de attach ODC, .NET 8 runtime para o
`Anvil.Connect`; a bridge O11 do pacote é a fina, sem o kernel; ODC Studio e/ou Service Studio nas versões do servidor,
ODC Studio no caminho oficial), extrair o zip numa pasta sem espaço (padrão `%USERPROFILE%\SSAM-Agent`), `setup --server <url>` (a credencial
é lida da entrada, nunca de argumento; `private\` fica só para o usuário, por `icacls`), `start/stop/status`, `doctor`,
configuração do cliente MCP com URL + token (`docs/exemplos/mcp-cliente-hospedado.json`), o que o agente faz e NÃO faz
(lista 4.4 e pastas 6.2), proxy corporativo (`HTTPS_PROXY`, o agente sobe o Node com `--use-env-proxy`; CA corporativa
com `--use-system-ca`), como entregar arquivos (`inbox\` → `agent:inbox/...`), e o que acontece quando o dono revoga ou
troca a credencial.

## 10. Faixas (lanes)

Quatro faixas. A `exec` da revisão anterior foi fundida na `policy`, que passa a se chamar `hosted`: os dois lados do
contrato de caminhos do servidor (`ws:`/`agent:` da política, espelho, staging e `fromAgent`) ficam numa faixa só, que
é dona de todo `platforms/odc/facade/hosted/**`; a `hub` já é a faixa mais pesada de protocolo e fica com a fronteira
limpa no `AgentLink` (I-1). O `AgentLink` falso (`fixtures/fake-agent-link.mjs`) continua sendo o meio de teste do
espelho e do relay.

### 10.1 Regras comuns

- Worktree próprio: `git -C C:\Users\andre\SSAM-Hybrid-servidor worktree add -b fase2/<key> C:\Users\andre\SSAM-Hybrid-servidor-wt\<key> servidor/fase2`
  (ponto de partida: o commit desta revisão).
- Cada arquivo tem UM dono (tabela 10.2). Arquivo de outra faixa: só leitura. Precisa de mudança alheia? Peça na resposta
  final, citando a interface da seção 10.3. Testes existentes só são editados pela faixa dona do módulo que testam.
- Nada de escrever fora do próprio worktree, de tocar o servidor da porta 7300, Studio, workers, `ssam connect`,
  `build.py`/`run_job`, `Anvil.DebugTokenHook`, ferramentas `mcp__ssam*`. Tudo com falsos. Portas de teste 7400-7499,
  pastas de teste em `%TEMP%`.
- Variáveis em todo teste: `ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`, `SSAM_ODC_OFFLINE=1` (o caminho hospedado ignora
  `SSAM_ODC_OFFLINE`, porque vai ao agente; o local continua sem tocar Studio nem cofre).
- Montar o worktree (dependências do Node): `powershell -File scripts\setup-dev.ps1 -Yes -NoUserEnv -SkipInstall -SkipMcp -SkipDoctor`.
- Testes da fachada: em `platforms\odc`, `node --test facade/tests/<arquivo>.test.mjs`. Regressão: rodar
  `node --test facade/tests/*.test.mjs portal/tests/*.test.mjs tests/*.test.mjs` antes e depois; uma falha que já
  existia na base não é regressão, mas vai citada.
- Sem dependência npm nova. Código e comentários em inglês; docs do dono em pt-BR.
- Commit com autor/committer Andre Machado <andre_c_machado@hotmail.com> e o rodapé `Co-Authored-By` de sempre. Sem push.
- Ordem de integração: `seam` → `hub` → `agent` → `hosted`. O teste de ponta a ponta (`hosted-e2e.test.mjs`, faixa
  `hosted`) se pula enquanto faltarem arquivos das outras faixas e é a aceitação da integração.

### 10.2 Donos de arquivo

| Faixa | Arquivos (exclusivos) |
|---|---|
| `hub` | `platforms/odc/facade/http-server.mjs`, `platforms/odc/facade/server-tokens.mjs`, `platforms/odc/facade/agent-hub.mjs` (novo), `platforms/odc/facade/agent-blobs.mjs` (novo, opcional), `platforms/odc/facade/tests/http-server.test.mjs`, `platforms/odc/facade/tests/agent-hub.test.mjs` (novo), `platforms/odc/facade/tests/server-tokens.test.mjs` (novo), `scripts/servidor.ps1`, `tests/servidor-ps1.test.mjs` (novo), `docs/SERVIDOR-LOCAL.md`, `docs/SERVIDOR-HTTPS.md` (novo), `docs/exemplos/mcp-cliente.json` |
| `agent` | `agent/**` (novo; inclui `agent/tests/**` e `agent/ssam-agent.ps1`), `scripts/agent-pack.ps1` (novo), `docs/AGENTE-CLIENTE.md` (novo), `docs/exemplos/mcp-cliente-hospedado.json` (novo) |
| `seam` | `platforms/odc/facade/executor.mjs` (novo), `lib.mjs`, `mcp.mjs`, `o11-bridge.mjs` (só `bridgeTarget` e `o11Bridge`), `studio-connect.mjs`, `studio-session.mjs`, `release-layout.mjs`, `lanes.mjs`, `o11-lane.mjs`, `anvil-cli.mjs`, `anvil-worker.mjs`, `local-settings.mjs`, `studio-write-lock.mjs`, `ssam-task.mjs`, `job-runner.mjs`, `kernel-delivery.mjs`, `studio-create-app.mjs`, `studio-open.mjs`, `module-map.mjs`, `ssam-reference.mjs`, `o11-cycle.mjs`, `o11-access.mjs`, `service-center/**`, `platforms/odc/portal/runtime/access.mjs`; testes existentes desses módulos (`facade/tests/{anvil-cli,anvil-worker,anvil-worker-first,studio-connect,o11-bridge,o11-lane,lanes,local-settings,studio-write-lock,ssam-task,job-runner,kernel-delivery,studio-create-app,studio-open,module-map,mcp,odc-access,o11-cycle,o11-access,ssam-reference,service-center-core,service-center-modern,service-center-studio,service-center-vault}.test.mjs`, `platforms/odc/portal/tests/access.test.mjs`); novos `facade/tests/executor.test.mjs`, `facade/tests/seam-guard.test.mjs`, `facade/tests/hosted-roots.test.mjs` |
| `hosted` | `platforms/odc/facade/ssam.mjs`, `platforms/odc/facade/hosted/**` (novos: `policy.mjs`, `tools.json`, `agent-executor.mjs`, `mirror.mjs`, `odc-stage.mjs`, `o11-stage.mjs`, `o11-relay.mjs`); novos `facade/tests/hosted-policy.test.mjs`, `hosted-tools.test.mjs`, `hosted-e2e.test.mjs`, `hosted-agent-executor.test.mjs`, `hosted-mirror.test.mjs`, `hosted-odc-stage.test.mjs`, `hosted-o11-stage.test.mjs`, `hosted-o11-relay.test.mjs`, `facade/tests/fixtures/fake-agent-link.mjs` |

- **Congelados para todas as faixas:** `platforms/odc/facade/odc-pipe.mjs` inteiro (o agente guarda uma cópia idêntica,
  conferida pelo teste de deriva, e a `hosted` importa `PipeError`); em `o11-bridge.mjs`, `bridgeRequest`,
  `BridgeError`, `TIMEOUTS`, `timeoutFor` e `MAX_REPLY_BYTES` (o agente copia, a `hosted` importa). A `seam` só edita
  `bridgeTarget` e `o11Bridge` nesse arquivo. Por isso `odc-pipe.test.mjs` não muda.
- Todo outro arquivo de `platforms/odc/facade/` e `platforms/odc/portal/runtime/` que não esteja listado acima
  (por exemplo `o11-studio.mjs`, `o11-publish.mjs`, `o11-environment.mjs`, `job-patch.mjs`, `ssam-evidence.mjs`,
  `discovery.mjs`, `app-urls.mjs`, `studio-locate.mjs`) pertence à `seam`, que só o edita se a costura exigir.
  `studio-locate.mjs` não precisa de mudança: não tem chamador em tempo de execução na fachada.
- Ninguém edita `catalog/tools.json`, `facade/**` da raiz, `kernel/**` nem este documento.

### 10.3 Interfaces entre faixas

**I-1 `AgentLink`** (implementa `hub` em `agent-hub.mjs`; usa `hosted`):

```js
export function createAgentHub({ dir, store, kernel /* {o11, odc, odcBridge} */, log, now, limits }) -> AgentHub
AgentHub = {
  handle(req, res, url): Promise<boolean>,   // /agent/v1/* (called by http-server after Host/Origin checks)
  link(tokenId): AgentLink,                  // stable object per token, survives reconnects
  sweep(): void, close(): Promise<void> }
AgentLink = {
  tokenId, customer,
  connected(): boolean,
  info(): { connected, credential /* the token has an agent credential */, instance, agentVersion, connectedAt,
            lastSeenAt /* memory only */, lanes, pack, studios, o11Connection,
            kernel: {o11, odc, odcBridge}, compatible: { odc: Compat, o11: Compat } },
  call(kind, params, { timeoutMs }): Promise<value>,   // rejects Error {code, message, executed: false|null, delivered: bool}
  putFile(absPath): Promise<BlobRef>,                  // registers a server->agent transfer
  receiveBlob(ref, destAbsPath): Promise<{ sha256, size }>,  // dest already confined by the caller (fromAgent); assembles, verifies, atomic write
  protocolError(message): void,                        // Close {reason:"protocol-error"} on the current channel
  onClose(fn /* (reason) */): () => void }            // revoked | expired | server-stop
```

`link.call` rejeita na hora com `AGENT_NOT_CONNECTED` quando não há canal e com `AGENT_BUSY` com 32 pendentes; com
canal, espera retomada até o prazo. Parâmetros/valores acima de `inlineMaxBytes` (mensagem serializada) viram blobs
dentro do hub, transparente para quem chama.

**I-2 Sessão servida** (implementa `hub` em `http-server.mjs`; usa `hosted` em `runServed`):

```js
startHttpServer({ createServer /* async (session) => McpServer */, dir, agents /* { kernel } | false */,
  publicHosts /* string[] */, logFile, observeCall /* (params, session) => {finish} | null */, ...phase1 options })
session = { tokenId, customer, lanes: string[], workspace: <dir>/customers/<tokenId>, agent: AgentLink | null }
parseServeArguments(args) -> + { publicHosts: string[], logFile: string | null, localStudios: boolean }
```

- `agents:{kernel}`: hospedado (rotas `/agent/v1/*`, `session.agent`).
- `agents:false` (padrão da biblioteca, usado por `--local-studios` e pelos testes existentes): comportamento da fase 1,
  `session.agent` = `null`, modo só do dono: recusa `allowRemote` e `publicHosts` ao iniciar e responde 403
  `FORWARDED_REFUSED` a pedido com cabeçalho de proxy (9.1).
- `parseServeArguments` recusa `--local-studios` junto com `--public-host` ou `--allow-remote`.

**I-3 Costura** (implementa `seam` em `executor.mjs`; usa `hosted` por import dinâmico): seção 4.1 inteira, mais
`hostedSpawnEnv` (4.7). `hosted` só importa `executor.mjs` com `await import()` dentro do caminho hospedado, para não
quebrar os testes existentes antes da integração.

**I-4 `AgentExecutor`** (implementa `hosted`; instancia `seam` em `createHostedContext`): seção 4.2, com o contrato de
erros 4.3, os espelhos 4.5/4.6, `fromAgent` (6.2) e o registro 4.7.

**I-5 Protocolo do canal** (servidor: `hub`; cliente: `agent`): seções 2 e 3.

**I-6 Layout e nomes de caminho** (`agent` cria o layout e confina no cliente; `hosted` mapeia, confina no servidor e
apresenta; `seam` põe os dados no workspace): seção 6.

**I-7 Versões** (`hosted` calcula `kernel` em `runServed` com `fileVersion` da `seam` e passa a
`startHttpServer({agents:{kernel}})`; `hub` calcula `compatible`; `agent` confere o processo): seção 7.

**I-8 Ops do servidor** (tudo dentro de `hub`): `/health` com `pid`, `--log-file`, `--public-host`, `--local-studios`
(parse e recusas), `servidor.ps1`.

**I-9 `pack.json`** (escreve `agent` no pacote; lê `agent` no `Hello.pack`; `hub` compara): seção 9.4.

### 10.4 Faixa `hub`: canal no servidor, credencial do agente, exposição, servidor.ps1

Construir:

- `agent-hub.mjs`: rotas da seção 2.3 com a conferência crua de `channel`/`transfer`/`index` antes do disco,
  `Hello`/`Welcome`, stream NDJSON com `Ping` a cada 15 s, subida com lotes, `accepted`/`result`/`pong`, pendentes num
  mapa por token com teto de 32 (`AGENT_BUSY`), id desconhecido ignorado e registrado, retomada (reescreve só as nunca
  aceitas) e substituição por `instance` (2.4), prazos, blobs em partes com sha256 e limite inline pela mensagem
  serializada (2.6), limite próprio por token, varredura de revogação e de troca de credencial (`rotated`, pelo
  `agentSha256` guardado no canal; 2.7), `compatible` por faixa (seção 7), `AgentLink` (I-1, com `credential` e
  `protocolError`). Log (`log({event})`) sem argumentos nem conteúdo. Nunca escreve `tokens.json`.
- `server-tokens.mjs`: credencial `ssam_agent_` (só sha256 guardado), `verifyAgent`, `lanes`, subcomandos `issue`
  (devolve `token` e `agentCredential` uma vez), `agent-rotate`, `list` (sem segredos e sem `lastSeenAt`), `revoke` (as
  duas).
- `http-server.mjs`: encaminhar `/agent/v1/*` ao hub (com `agents`), `createServer(session)` (I-2) com
  `workspace = <dir>/customers/<tokenId>`, `observeCall(params, session)`, `--public-host`, `--log-file`,
  `--local-studios` (parse e recusas de I-2), modo só do dono com `agents:false`, `/health` com `pid`, keepalive SSE
  (9.1). `/mcp` recusa credencial `ssam_agent_` (401); `/agent` recusa token MCP.
- `http-server.test.mjs`: o teste de paridade `ssam serve` × `ssam mcp` (linhas 183-224) passa a subir
  `serve --port 0 --local-studios`: o servidor hospedado tem um parágrafo a mais nas instruções, e a paridade hospedada é
  coberta pelo `hosted-e2e.test.mjs`.
- `scripts/servidor.ps1`: as duas correções da seção 9.2.
- Docs: `docs/SERVIDOR-LOCAL.md` (troca o "desenho curto" da fase 2 por um resumo e um link para este documento;
  hospedado por padrão e `--local-studios`; credencial do agente e `agent-rotate`; `--public-host`, `--log-file`),
  `docs/SERVIDOR-HTTPS.md` (9.1 passo a passo, inclusive "nunca expor `--local-studios`" e a conta dedicada), ajuste de
  `docs/exemplos/mcp-cliente.json` se precisar.

Testes que têm de passar (sozinha):

- `agent-hub.test.mjs`: hello → welcome com `kernel` e `compatible` (igual, diferente, sem Studio, pacote velho,
  faixa fora do token); `call` chega no stream e `result` resolve `link.call`; `accepted` vs. não entregue
  (`executed:false` quando nunca escrito); retomada com a mesma `instance` reescreve só a pendente nunca aceita e um
  `result` repetido não duplica; `instance` nova substitui (stream antigo recebe `close replaced`); morte por falta de
  `pong` (tempos injetados); revogação fecha stream, rejeita pendentes com `AGENT_REVOKED` e o próximo pedido leva 403,
  tudo em ≤ 1 s; `agent-rotate` fecha o canal com `close rotated` em ≤ 1 s e a credencial velha leva 401; 33ª chamada →
  `AGENT_BUSY`; `result` com id de outro token ou desconhecido é ignorado; `transfer` fora do formato, com `%2e%2e` ou
  `index` ≥ `parts` → 400 sem nenhum arquivo criado; blobs: subida em partes com conferência, parte errada → 400,
  montagem com sha errado → `BLOB_HASH_MISMATCH`, descida em partes; valor que só passa de `inlineMaxBytes` depois de
  serializado (muitas aspas ou texto não ASCII) vai como `valueBlob`; isolamento (canal e transferência de outro token
  → 404); 413 e 429; `tokens.json` com o mesmo conteúdo e mtime depois de uma sessão inteira do hub.
- `server-tokens.test.mjs`: `issue` mostra as duas credenciais uma vez e `tokens.json` não contém nenhum texto puro;
  `verifyAgent`; `agent-rotate` invalida a anterior; `revoke` invalida as duas; registros da fase 1 continuam válidos.
- `http-server.test.mjs`: tudo o que já testava continua passando (o de paridade com `--local-studios`); `/health` com
  `pid`; `--public-host` aceita o Host e a Origin `https://<host>` e continua recusando os outros; `--local-studios`
  com `--public-host` ou `--allow-remote` é recusado no parse; com `agents:false`, pedido com `X-Forwarded-For` ou
  `CF-Connecting-IP` → 403 `FORWARDED_REFUSED`; keepalive SSE aparece numa chamada lenta (handler falso); `createServer`
  recebe `session` com `workspace` e `agent`.
- `tests/servidor-ps1.test.mjs` (portas 7400-7499, `SSAM_SERVER_DIR` temporário): `start` chamado com saída capturada
  volta em até 30 s; `status`; `start` de novo diz que já roda; com outro processo respondendo `/health` na porta
  (servidor falso com outro pid) `start` sai com 1 e não deixa processo; `stop`.

### 10.5 Faixa `agent`: agente fino, pacote e guia do cliente

Construir em `agent/` (sem nenhum import de `platforms/`):

- `ssam-agent.mjs` com `setup --server <url> [--root <pasta>] [--credential-file <f>]` (lê a credencial da entrada
  padrão quando não há arquivo; nunca imprime; recusa raiz com branco; `icacls` em `private\`), `run` (primeiro
  plano), `status`, `doctor` (inclui as duas opções do Node, 9.5).
- `lib/channel.mjs` (hello, stream com `fetch` lendo NDJSON, caixa de saída com lotes e confirmação por 204, `pong`,
  reconexão 2.5, saídas 2 em 401/403/`revoked`/`expired`/`rotated`, 3 em `replaced`, 4 em 409), `lib/kinds.mjs` (os
  9 tipos de 4.4 e as listas, posições, linha final e versão por pid de 4.8; tudo o mais recusado),
  `lib/workspace.mjs` (seção 6.2: normalização, prefixos por papel, `agent:` nas posições, `json:"agent-paths"` só nos
  5 campos do manifesto, relativização das respostas), `lib/blobs.mjs`, `lib/outbox.mjs` (3.4: fila, mapa
  `id → running|done` até a confirmação), `lib/odc-pipe.mjs` (cópia IDÊNTICA de `platforms/odc/facade/odc-pipe.mjs`),
  `lib/o11-wire.mjs` (cópia de `bridgeRequest`, `BridgeError`, `TIMEOUTS`, `timeoutFor`, `MAX_REPLY_BYTES` de
  `o11-bridge.mjs`), `lib/studios.mjs` (processos + versão, localização da instalação para o `Hello`),
  `lib/odc-attach.mjs` (`ODC3.Bridge.Client.dll <pid> attach <dll do pacote>`), `lib/o11-connect.mjs` (4.9).
- `o11.bridge`: params `{method, params, timeoutMs?}`; ignora `port` e `authorization` recebidos; porta só de
  `private\o11-connection.json`; chave de `private\authority\bridge.key`.
- Dependências injetáveis para teste (`createAgent({ root, config, deps: { processes, locate, fileVersion, describe,
  attachOdc, attachO11, icacls, fetch, now, setTimeout } })`).
- `agent/ssam-agent.ps1 start|stop|status` com as mesmas correções do `servidor.ps1` (9.2).
- `scripts/agent-pack.ps1` (9.4), `docs/AGENTE-CLIENTE.md` (9.5), `docs/exemplos/mcp-cliente-hospedado.json`
  (`{"mcpServers":{"ssam":{"type":"http","url":"https://<host>/mcp","headers":{"Authorization":"Bearer ${SSAM_TOKEN}"}}}}`).

Testes que têm de passar (sozinha), `node --test agent/tests/*.test.mjs` na raiz do worktree:

- confinamento: `..`, absoluto, UNC, `:` alternativo, NUL, nomes de dispositivo (com extensão), segmento terminado em
  ponto ou espaço, prefixos proibidos (`odc/studio/`, `private/`, `bin/`, `pack.json`), link simbólico que escapa;
  `agent:` resolvido por papel (saída fora de prefixo gravável → `PATH_FORBIDDEN`); `json:"agent-paths"` nos 5 campos
  nos dois sentidos (absoluto num desses campos → `PATH_FORBIDDEN`; outros campos intactos); relativização de respostas;
  `setup` recusa raiz com espaço e chama `icacls` (falso) em `private\`;
- listas: tipo desconhecido (inclusive `file.stat`, `agent.info`, `studio.locate`), `attach` por `odc.pipe`, `login` e
  `export_modules` por `o11.bridge` → recusa com `executed:false`; posição de caminho com absoluto → `PATH_NOT_AGENT`;
- linha final: `['open','Mod C:\\x.oml']` e `['data-insert','M','E','--authorize','x --records-file C:\\s.json']` →
  `PATH_FORBIDDEN`; `\r`, `\n` ou NUL num argumento → `COMMAND_NOT_ALLOWED`; `--authorize "pode publicar..."` passa;
  `portal-session fetch agent:odc/journal/portal/requests/x.json` passa e com absoluto é recusado;
- versão por pid: `odc.pipe`/`odc.attach`/`o11.connect` contra um pid cuja `ProductVersion` difere do
  `Welcome.kernel` → `STUDIO_VERSION_MISMATCH`;
- `odc.pipe` contra um servidor falso de pipe nomeado (`\\.\pipe\ODC3-Bridge-v35-<pidfalso>`), inclusive
  `BRIDGE_VERSION_MISMATCH`;
- `o11.bridge` contra uma bridge TCP falsa (pode importar só para leitura `platforms/odc/facade/tests/fixtures/fake-o11-bridge.mjs`):
  `authorization` recebida é descartada e a chave local é posta; um `port` recebido é ignorado (vai sempre à porta do
  registro); `sc_api` com `args.file` absoluto → `PATH_NOT_AGENT`; `args.outFile` → `PATH_FORBIDDEN`;
  `environment_session download` com `outputDirectory` fora de `o11/` → recusa;
- canal contra um hub HTTP falso no teste: hello, stream, `call` → `accepted` → `result`, `pong`, reconexão com relógio
  injetado, parada em 403, `close replaced` e `close rotated` sem reconexão, `close protocol-error` reconecta; caixa de
  saída: POST do `accepted` perdido → o hub falso reescreve o `call` e ele NÃO roda de novo; `result` reenviado depois
  da reconexão até o 204; blobs nos dois sentidos com conferência e parte errada;
- pacote: `agent-pack.ps1 -NoBuild -Prebuilt <árvore falsa>` gera o zip com o layout 6.2, `pack.json` com sha256
  corretos e nada proibido dentro (sem `.cs`, sem `.local\server`, sem chave);
- deriva: `agent/lib/odc-pipe.mjs` byte a byte igual a `platforms/odc/facade/odc-pipe.mjs`; nenhum arquivo de `agent/`
  importa de `platforms/`.

### 10.6 Faixa `seam`: costura do executor na fachada

Construir:

- `executor.mjs` (4.1): `CALL_KINDS` (9), `MACHINE_KINDS` (6), `LocalExecutor` implementando os 6 tipos de máquina com
  o código de hoje movido para trás da costura (coluna "Local" da 4.4; `file.*` → `KIND_NOT_ALLOWED`), `DenyExecutor`,
  `setDefaultExecutor`, `runWithExecutor`/`currentExecutor`/`hostedContext`/`servedWithoutContext`/`workspacePath`,
  `hostedSpawnEnv` (4.7, lista fechada), `fileVersion` (PowerShell `(Get-Item).VersionInfo.ProductVersion`),
  `createHostedContext` (layout 6.1, `<ws>/odc/tenants.json`, chave nova do relay, import dinâmico do
  `AgentExecutor`).
- Trocar cada chamada direta pela costura: `lib.mjs` (`client`, `studioPids`, `attach`; o hospedado vai ao agente
  antes do atalho de `SSAM_ODC_OFFLINE`), `o11-bridge.mjs` (só `bridgeTarget`, hospedado sem chave e com a porta do
  registro, e `o11Bridge`, hospedado por `o11.bridge` sem porta), `studio-connect.mjs` (`bridgeCall`/`probeO11`/
  `pingO11`/`authenticate` → `o11.bridge`; `connectO11` hospedado → `o11.connect`; `assertSelectedO11` hospedado →
  `o11.selected`; nenhum dos dois muda `process.env` nem grava `.local/connections`), `lanes.mjs` (`studioProcesses`;
  `run()` de verbos O11, inclusive `data`, com `hostedSpawnEnv` no hospedado e `laneEnvironment` no local),
  `service-center/auth.mjs` (`studioRunning`), `service-center/bridge.mjs` (`locateStudioBridge` por `readConnection`;
  pedido padrão pela costura).
- Falha fechada do O11 (4.7): `o11LaneOf().bridge` como getter no hospedado (porta do relay ou `O11_NOT_CONNECTED`),
  `local` no workspace e `worker` nulo; `laneEnvironment`/`createAnvilRunner` hospedados por `hostedSpawnEnv`;
  `--port`/`--bridge-port` só do registro.
- Regra das raízes e tabela 6.1: `lib.mjs` (dados por getters de contexto), `o11-lane.mjs`, `studio-session.mjs
  readConnection` → `currentExecutor().o11Connection()`, `anvil-worker.mjs` (worker O11 desligado no hospedado; ODC
  permitido), `ssam-task.mjs tasksDir`, `studio-write-lock.mjs`, `job-runner.mjs`, `kernel-delivery.mjs`,
  `studio-create-app.mjs` (evidência em `<ws>/odc/lab/create-app/<stamp>`, diário em `<ws>/odc/journal`),
  `ssam-reference.mjs`, `lanes.mjs catalog()`, Service Center (recibos, estado, exportações). Spawns hospedados com
  `cwd`/`TEMP` do workspace (`job-runner.mjs:139`, `studio-create-app.mjs:185`, `ssam-reference.mjs:205`).
- Caches por executor: `pidListing`, `access` (mapa por `context.id`).
- Comportamentos hospedados: `createAccess` com cofre e prompt recusando (`HOSTED_STUDIO_SESSION_ONLY`,
  `HOSTED_PROMPT_UNAVAILABLE`) e `auth:"api-client"|"portal-credential"` recusados em `portal/runtime/access.mjs`;
  `mcp.mjs` sem `portalBridge`/`credentialStatus` no hospedado (nenhuma leitura do cofre do dono), sem tenant padrão do
  dono, com a troca de `server.registerTool` que reaplica o contexto capturado (4.1), `hybrid_tenants` com
  `<ws>/odc/tenants.json`; `tenants()` hospedado lê `<ws>/odc/tenants.json`; `readLocalSettings()` hospedado → `null`;
  `builder()` hospedado com `hostedSpawnEnv('odc')` (`SSAM_HYBRID_ODC_ROOT=<ws>/odc`) e `ensureBuilder()` hospedado
  nunca compila: builder desatualizado → `COMPONENT_STALE`; `doctor()` hospedado (agente, versões, Studio do cliente,
  bridge anexada, catálogo espelhado; nada de dotnet/builds/cofre do servidor); Service Center hospedado (`present` →
  falso, `opener` recusa, `session:"vault"` e `lifetime` → `HOSTED_STUDIO_SESSION_ONLY` sem ler cofre, `hiddenSignIn`
  sem a checagem do cofre e com `SECRET_NOT_FOUND` → `HOSTED_PROMPT_UNAVAILABLE`, transporte de cofre recusado).

Testes que têm de passar (sozinha):

- regressão: a suíte da fachada inteira como na base (o local não muda byte a byte);
- `executor.test.mjs`: `CALL_KINDS` congelado com 9; despacho do `LocalExecutor` por tipo com funções de baixo nível
  injetadas; `runWithExecutor`/`currentExecutor`/`hostedContext` (aninhamento, propagação por promessas e
  temporizadores, padrão local); `LocalExecutor` dentro de contexto hospedado → `SEAM_LOCAL_IN_HOSTED`; com
  `setDefaultExecutor(new DenyExecutor())` (restaurado no fim): `studio(['status'])` fora de contexto →
  `HOSTED_CONTEXT_LOST` com `executed:false` e nenhum spawn; auxiliar de raiz de dados e `hostedSpawnEnv` fora de
  contexto → `HOSTED_CONTEXT_LOST`;
- `hosted-roots.test.mjs` com um executor FALSO num contexto hospedado e workspace temporário:
  - `studio(['status'])` chama `studio.processes` e `odc.pipe` do falso; `o11Bridge(bridgeTarget()).ok` chama
    `o11.bridge` sem `port` nem `authorization`; `probeO11` idem;
  - FERRAMENTAS REGISTRADAS (não só os auxiliares), registradas dentro do contexto com `anvilRoot` padrão:
    `registerO11Cycle`, `registerSsamTask`, `jobTool` com `captureProducers`, `createStudioCreateApp`,
    `registerSsamReference` e `createFacadeServer`; todos os caminhos de dados (`journal`, `lab`, catálogo, `inspect`,
    registros, pedidos e recibos do Portal, `lane.local`, `tasksDir`, travas, evidência de create-app, recibos do
    Service Center) caem no workspace;
  - sem registro O11: `o11_deliver`, `jobTool` com `captureProducers`, `lanes.run('o11','data')`, `bridgeTarget()` e
    `locateStudioBridge()` falham com `O11_NOT_CONNECTED`/`STUDIO_NOT_CONNECTED` e o espião de `execFile` não vê
    NENHUM spawn nem conexão TCP; `assertSelectedO11` sem registro e com `o11.selected` `connected:false` → lança;
    `jobTool` sem captura, `ssam_reference {lane:"o11"}` e `dependencies inspect|help` rodam com a porta do relay;
  - com registro: todo spawn O11 leva `ANVIL_BRIDGE_PORT` = porta do relay, `ANVIL_AUTHORITY_DIR` =
    `<ws>/state/relay-authority`, `cwd` e `TEMP` no workspace, e nenhum outro `ANVIL_*`/`SSAM_*` de `process.env`
    (o teste põe `ANVIL_BRIDGE_PORT`, `ANVIL_AUTHORITY_DIR` e `ANVIL_CSHARP_RUNTIME_REGISTRATION` falsos no ambiente e
    eles não chegam); `--port`/`--bridge-port` = porta do relay; o spawn do builder leva `SSAM_HYBRID_ODC_ROOT=<ws>/odc`;
    `ensureBuilder` com builder desatualizado → `COMPONENT_STALE` sem `dotnet build`;
  - `readConnection` devolve `o11Connection()` do falso; worker O11 desligado;
  - handlers de `registerOdcTools` e `registerStudioCreateApp` chamados por fora de qualquer contexto ALS ainda chegam ao
    executor falso (troca de `registerTool`);
  - dois contextos falsos têm listas de pids separadas;
  - cofre/prompt recusados com os códigos; `lifetime` → `HOSTED_STUDIO_SESSION_ONLY` sem leitura de cofre (espião);
    `hiddenSignIn` sem `present` e `SECRET_NOT_FOUND` → `HOSTED_PROMPT_UNAVAILABLE`; `tenants()` nunca lê o
    `tenants.json` do repositório; `createFacadeServer` no hospedado nunca chama o cofre (espião);
  - depois de exercitar os módulos, nenhuma pasta de dados do repositório nem `%USERPROFILE%\.ssam-hybrid` mudou;
- `seam-guard.test.mjs`: varredura estática de `platforms/odc/facade/**` e `platforms/odc/portal/runtime/**`:
  `net.createConnection`, `tasklist`, `Get-CimInstance`, `reg query`/`reg.exe`, `Anvil.Connect`, `paths.client` e
  imports/chamadas de `pipeCall`, `bridgeRequest` e `bridgeCall` só aparecem nos arquivos de implementação local
  (`executor.mjs`, `odc-pipe.mjs`, `o11-bridge.mjs`, `studio-connect.mjs`, `studio-locate.mjs`, `o11-lane.mjs`,
  `reader-client.mjs`, `anvil-worker.mjs`, `debug-*.mjs`, `service-center/vault.mjs`, `service-center/bridge.mjs`);
  `.bridge` de `o11LaneOf(...)` só nos pontos conhecidos de 4.7; spawn de prompt PowerShell (`-File` de um script de
  credencial) só nos dois `openPrompt` (recusados no hospedado); `fetch(`, auxiliares de cofre e `cognito-login` do
  `portal/runtime` só nos módulos de hoje (lista no próprio teste). Um uso novo fora da lista falha o teste.

### 10.7 Faixa `hosted`: executor hospedado, espelhos, relay, política, fiação e aceitação

Construir:

- `hosted/agent-executor.mjs` (4.2, 4.3, 4.7): `AgentExecutor`, registro sintetizado (porta do relay, Studio do kernel,
  autoridade do relay), remoção de `port`/`authorization` em `o11.bridge`.
- `hosted/mirror.mjs`: `fromAgent` (6.2), `<ws>/<rel>` ↔ `agent:<rel>`, regra de espelho de 4.5 (entrada com cópia
  para `journal/staging/<sha256><ext>`, saída só em prefixo gravável, direção, envio por sha256, vinda por
  `file.list`/`file.get`/`receiveBlob`), cota do workspace (6.1).
- `hosted/odc-stage.mjs` (4.5) e `hosted/o11-stage.mjs` (4.6), inclusive `portal-session fetch`, `data --out`,
  `sc_api args.file` e `download` com `outputDirectory` nulo.
- `hosted/o11-relay.mjs` (4.6): chave do relay do cliente, tempo constante, linha atrasada registrada.
- `hosted/tools.json` com as ferramentas da seção 5 (78 na fase 2, 79 desde a nona entrega; classe, faixa, regra do agente, ponteiros `in`/`out` de 6.4,
  motivo).
- `hosted/policy.mjs`: `wrapHostedTool(name, config, handler, { context, link, lanes, run })` faz, nesta ordem:
  indisponível (`HOSTED_UNAVAILABLE`); faixa fora do token (`HOSTED_LANE_DISABLED`); agente exigido e desconectado ou
  token sem credencial (`AGENT_NOT_CONNECTED`, seção 8); `compatible[faixa]` falso
  (`STUDIO_VERSION_MISMATCH`/`AGENT_PACK_MISMATCH`, seção 7); faixa o11 sem registro (`O11_NOT_CONNECTED`, exceto
  `ssam_connect` e relatórios); cota (`WORKSPACE_FULL`); resolução e confinamento dos caminhos (6.3/6.4, entrada e
  saída); `ssam_job` `lane:"odc"` sem `base` recebe a fixture neutra (fase 3); handler dentro de `run(context, fn)`;
  limpeza da evidência de terceiro (`hosted/evidence.mjs`, fase 3) e apresentação da resposta (6.3, item 4). `run` é
  injetável (nos testes, `(ctx, fn) => fn()`; na fiação, `runWithExecutor`).
- `ssam.mjs`: `createSsamServer({ o11, odc, deps, hosted })` — com `hosted` = `{ context, session }`: o portão em volta
  de cada ferramenta (inclusive os proxies ODC e, explicitamente, `ssam_friction`), jobs inline em
  `<ws>/odc/.local/jobs/inline` e diário do patch em `<ws>/odc/journal` (`ssam.mjs:330-335`), pasta de trabalho do
  `o11_data` em `o11LaneOf().local/data` (hoje `LANES.o11.root`, `ssam.mjs:230`), `ssam_evidence` com
  `roots: [<ws>/odc, <ws>/o11, <ws>/inbox]`, um parágrafo a mais nas instruções (ferramentas indisponíveis, nomes
  `ws:`/`agent:`, arquivos ODC em `ws:odc/` e O11 em `ws:o11/`, `ssam_connect` antes do O11), `ssam_doctor` com a seção
  `agent` (de `link.info()`) e as faixas pelo executor. Sem `hosted`, `createSsamServer` fica exatamente como hoje.
- `runServed`: `--local-studios` → fase 1 (`agents:false`, `LocalExecutor`); senão `setDefaultExecutor(new
  DenyExecutor())`, `kernel` (seção 7), `startHttpServer({ agents: { kernel }, ... })`, contexto hospedado por token em
  cache (`createHostedContext`, import dinâmico) fechado em `link.onClose`, `createSsamServer` construído dentro de
  `runWithExecutor`, fricção por cliente (`createStore({ root: workspace })`).

Testes que têm de passar (sozinha), com `fixtures/fake-agent-link.mjs` (um `AgentLink` em memória com respostas
programadas, blobs e `protocolError` registrado) e workspace temporário:

- `hosted-mirror.test.mjs`: `fromAgent` recusa `..`, absoluto, letra de unidade, UNC, `:`, NUL, dispositivo, ponto ou
  espaço final, prefixo fora de `odc|o11|inbox` (inclusive `state/`) e junção que escapa, com
  `AGENT_PROTOCOL_VIOLATION`, `protocolError` chamado e nenhum arquivo criado ou lido; `agent:..\..\..\.local\server\tokens.json`
  numa resposta, numa entrada de `file.list` e como destino de vinda não toca o arquivo; entrada em `inbox/` é copiada
  para `journal/staging/<sha256>` antes do envio; saída fora de prefixo gravável → `PATH_NOT_STAGEABLE` sem chamar o
  link; pasta de evidência: recibo da bridge no agente nunca é sobrescrito pelo servidor; cota estourada →
  `WORKSPACE_FULL`;
- `hosted-odc-stage.test.mjs`: `snapshot` traz o `.oml` e o `.json` e reescreve a resposta; comandos de manifesto
  enviam o manifesto reescrito (só os 5 campos) com base e candidato (pulados quando o sha256 bate) e trazem a evidência
  depois do `merge`; `authorize` traz o manifesto alterado; `open` com OML local, `--records-file`, `portal-call` e
  `portal-session fetch` enviam para as pastas certas; `data --out` traz; `reference-snapshot` traz o `output`;
  `assets` traz `modules.json`; caminho fora do workspace → `PipeError {code:'PATH_OUTSIDE_WORKSPACE', sent:false}` sem
  chamar o link;
- `hosted-o11-stage.test.mjs`: `snapshot_module` reescreve e traz (e `data.path` não `agent:` → violação);
  `merge_from_oml` envia as duas; `environment_session download` com pasta do workspace reescreve e traz `FilePath`, e
  com `outputDirectory:null` usa `agent:o11/downloads/<id>`; `sc_api PublishSolution` com `args.file` do workspace envia
  para `agent:o11/journal/staging/<sha256>.osp` e reescreve; `login`, `export_*` e `outFile` recusados com
  `executed:false`; `port` e `authorization` nunca chegam ao link;
- `hosted-agent-executor.test.mjs`: mapeamento de erros não entregue (`sent:false`/`executed:false`) vs. entregue sem
  resultado (`sent:true`/`executed:undefined`); `o11Connection()` sintetizado com a porta do relay, o Studio do kernel e
  `<ws>/state/relay-authority`; `null` sem conexão do agente;
- `hosted-o11-relay.test.mjs`: um cliente no formato do `BridgeClient` com a chave do relay do cliente é encaminhado;
  a chave do controlador do servidor é recusada; a chave do relay de OUTRO cliente é recusada; agente desconectado →
  `executed:false`; queda depois da entrega → socket fechado sem resposta; cliente com tempo de leitura menor que o
  espelho (agente falso lento) não recebe resposta e o relay registra `relay-late`;
- `hosted-tools.test.mjs`: toda ferramenta registrada por `createSsamServer()` (sem hospedado) + `ssam_friction` tem
  classificação, e vice-versa; classes e regras válidas; cada ponteiro existe no schema pela gramática de 6.4; totais
  da seção 5 (21/31/19/7);
- `hosted-policy.test.mjs` (link, contexto e `run` falsos): indisponível não chama o handler; agente desconectado →
  `AGENT_NOT_CONNECTED` com a continuação, e `credential:false` → o `why` do `agent-rotate`; ferramenta de servidor roda
  sem agente; regras mistas (`ssam_map` com `.oml` sem agente, com nome de módulo exige agente; `o11_access plan` vs.
  `apply`; `ssam_job` com `captureProducers`); faixa o11 sem registro → `O11_NOT_CONNECTED` (e `ssam_connect` passa);
  versão diferente → texto com as duas versões; faixa fora do token; `ssam_job {lane:"odc"}` sem `base` →
  fixture neutra (fase 3); `ws:` resolvido; `ws:state/...` e absoluto fora → recusa; relativo de entrada cai em
  `ws:<faixa>/` e de saída em `ws:odc/lab/` (ODC) e `ws:o11/` (O11); `/basedOn/job` confinado; `agent:inbox/x` busca pelo
  executor falso; resposta com caminhos do workspace vira `ws:` (no objeto e no texto JSON) e caminho do servidor vira
  `<servidor>`; `ssam_friction` passa pelo portão;
- regressão: os testes existentes que importam `ssam.mjs` continuam passando (sem import estático de `executor.mjs`);
- `hosted-e2e.test.mjs` (aceitação da integração; pula enquanto faltar `agent-hub.mjs`, `executor.mjs`,
  `hosted/agent-executor.mjs` ou `agent/ssam-agent.mjs`): servidor em porta 7400-7499 com `SSAM_SERVER_DIR`
  temporário, token + credencial do agente, agente real em processo com Studios falsos (pipe ODC falso, bridge O11
  falsa, processos e versões injetados), cliente MCP por HTTP: `tools/list` com os mesmos nomes do stdio; `ssam_doctor`
  mostra o agente; `studio_status` passa pelo agente; `studio_snapshot` devolve `ws:` e o arquivo está no workspace;
  `o11_studio {command:"status"}` antes do `ssam_connect` → `O11_NOT_CONNECTED`, depois passa pela bridge falsa;
  caminho absoluto fora do workspace → recusa; versão diferente → recusa; um agente que devolve
  `agent:..\..\x` → `AGENT_PROTOCOL_VIOLATION` e nada escrito; revogação fecha a sessão MCP e o canal em ≤ 2 s;
  nenhuma escrita fora de `customers/<tokenId>` (pastas de dados do repositório, `.local` do kernel e
  `%USERPROFILE%\.ssam-hybrid` inalterados).

## 11. Fora de escopo agora

- Instalador, ofuscação e assinatura de código (o Controle Inteligente de Aplicativos do Windows pode bloquear DLLs não
  assinadas no cliente; a seleção assinada existente só cobre o runtime ODC).
- Vários kernels no servidor: há UM kernel por faixa, preso à versão do Studio instalado no servidor (hoje Service Studio
  11.55.92 e ODC Studio 1.7.28, desde as atualizações de 12/10/2026). Cliente em outra versão é recusado (seção 7) até o dono atualizar o servidor.
- Propriedade intelectual no O11: resolvido na fase 3 ([O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md)). O pacote leva só a
  bridge fina (`Anvil.Bridge.dll` sem `Anvil.Core.dll`, sem `Anvil.CSharp.dll`, sem `Esprima.dll`); a lógica do kernel
  que rodava dentro do Studio passou para o servidor, e `scripts\pack-ip-scan.ps1` recusa o pacote se aparecer
  assembly ou namespace do kernel ou texto de cliente fora da tabela de exceções conhecidas (§6.4 de lá).
- Prompts de credencial na máquina do cliente (API Client, conta do Portal, cofre do Service Center, segredos de banco
  externo): no hospedado só funciona o que já está na sessão do Studio ou no cofre do cliente lido pela bridge.
- Entrega C# de runtime (`ANVIL_CSHARP_RUNTIME_REGISTRATION`/`csharp-runtime.json`) no hospedado: falha fechada (4.7).
- Ajuste de tempo do `BridgeClient` do kernel (120 s, 4.6): resolvido na fase 3, com `ANVIL_BRIDGE_TIMEOUT_SECONDS=600`
  só no hospedado ([O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md) §4.4).
- Depurador (`ssam_debug*`) e sessão controlada (`context`/`propose`/`continue`/`status`).
- Agente fora do Windows, atualização automática do agente, vários agentes por cliente, OAuth no MCP (só bearer),
  rota HTTP de administração, leitores residentes por cliente.

## 12. Perguntas abertas

1. O11 hospedado leva `Anvil.Core.dll` compilado para a máquina do cliente. Aceitar na fase 2 (com `--lanes odc` para
   reter) ou adiar o O11 hospedado até existir uma bridge fina? **Decidida:** bridge fina, sem o kernel no pacote
   ([O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md)).
2. O workspace é chaveado pelo `tokenId`; reemitir o token cria outro workspace. Quer um id de cliente estável entre
   tokens?
3. Faixas padrão de um token novo: `odc,o11` (como está) ou só `odc`?
4. Fase 3: um tipo `prompt.open` no agente para os prompts de credencial na máquina do cliente?
5. `ODC3.Bridge.Client` exige o ODC Studio em `C:\Program Files\OutSystems\ODC Studio\ODC Studio`. Recompilar o
   cliente sem essa trava ou aceitar o limite?
6. Node no cliente: exigir Node 24 instalado ou levar `node.exe` no zip (`-NodeExe`, ~80 MB)? **Decidida
   (2026-10-05):** o `node.exe` vai no pacote por padrão, só com a licença dele; `-NoNode` é a exceção
   ([O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md) §6.3, §7.1).
7. As ferramentas indisponíveis continuam no `tools/list` hospedado (mantém a paridade da fase 1) e recusam na chamada.
   Prefere escondê-las nas sessões hospedadas?
8. Leitor residente e índice de módulos compartilhados entre clientes por sha256 (sem listagem cruzada). Aceitável, ou
   um leitor por cliente (mais memória)?
9. Primeiro testador de fora: túnel rápido (`trycloudflare.com`, URL muda a cada início) ou túnel nomeado com domínio?
   **Decidida (2026-10-05):** túnel rápido, pelo `scripts\tunel.ps1` ([O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md) §13.3;
   roteiro em [PROVAS-AO-VIVO.md](PROVAS-AO-VIVO.md)).
10. `studio_build` expõe as features C# de projetos do dono (FloodQuotes, Quotes...). Restringir a lista no hospedado?
11. Dados de terceiros no servidor: `ssam_job {lane:"odc"}` roda por padrão em
    `kernel/tests/fixtures/odc/wrightflood-personal-r8.oml`, captura de um tenant real de cliente, e as provas do
    discover usam a mesma fixture. O desenho da fase 2 exigia `base` no hospedado (`HOSTED_BASE_REQUIRED`). Prefere
    uma fixture neutra no lugar, e as provas do discover no hospedado devem omitir essa fixture? **Decidida (2026-10-05):** fixture
    neutra no hospedado e provas sem a captura de terceiro ([O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md) §7.2).
12. Tenant padrão por cliente: hoje toda escrita de tenant hospedada exige `confirmTenant` (6.1/seção 5). Quer um jeito
    de o dono gravar `default` no `<ws>/odc/tenants.json` do cliente (e enviar a mesma política para a raiz da bridge do
    agente)?
13. Conta Windows dedicada e sem privilégio para o `ssam serve` hospedado (9.1): adotar já no primeiro testador?
14. Cota de 5 GiB por workspace e 32 chamadas pendentes por token: valores bons para começar?

## 13. Rastreabilidade da revisão 1

| Item da crítica | Onde |
|---|---|
| M1 O11 sem registro caía no Studio do dono | 4.7 (getter `bridge`, `hostedSpawnEnv`, `assertSelectedO11`), 8, 10.6, 10.7 (portão) |
| M2 relay aceitava a chave do servidor | 2.8, 4.1, 4.2, 4.6, 4.7, 10.7 |
| M3 caminhos do agente sem confinamento no servidor | 2.3, 2.6, 6.2 (`fromAgent`), 10.4, 10.7 |
| M4 contexto perdido falhava aberto; serve fase 1 exposto | 0, 4.1 (`DenyExecutor`), 9.1, 9.3, I-2, 10.7 |
| M5 estado de módulo não separado por cliente | 4.1 (caches), 6.1 (tabela), 10.6 |
| M6 builder lia dados do dono | 4.7 (`SSAM_HYBRID_ODC_ROOT`), 6.1, seção 5 linha 13, 10.6 |
| M7 posições de staging faltando | 4.5 (`portal-session fetch`), 4.6 (`sc_api args.file`, `download`), 4.8 |
| M8 contrato de caminhos inconsistente | 4.5 (regra de espelho), 6.3, 6.4 (`in`/`out`, `/basedOn/job`) |
| M9 linha final do `odc.pipe` | 4.8, 6.2 (raiz sem branco), 10.5 |
| M10 `port` do `o11.bridge` | 4.4, 4.6, 10.5, 10.7 |
| M11 `agent-rotate` sem efeito; `lastSeenAt` em `tokens.json` | 2.2, 2.7, 3.3, 9.3, 10.4 |
| M12 donos de arquivo e faixas | 10 (quatro faixas), 10.2 (congelados) |
| S1 inline pela mensagem | 2.6 |
| S2 recursos sem limite | 2.3, 2.6, 6.1 |
| S3 versão do processo | 4.8, 7 |
| S4 Service Center hospedado | seção 5 (notas), 10.6 |
| S5 tempo do kernel | 4.6, 11 |
| S6 `cwd`/`TEMP` | 4.7, 6.1 |
| S7 `seam-guard` ampliado | 10.6 |
| S8 raiz do agente fora de `%LOCALAPPDATA%` | 6.2 |
| S9 menos tipos; caixa de saída | 2.4, 3.4, 4.4 |
| S10 regra das raízes | 4.1, 6.1, 10.6 |
| S11 `credential` em `info()` | 8, I-1 |
| S12 fixture de terceiros | seção 5 linha 7, 12 (pergunta 11) |
| S13 conta dedicada | 9.1, 12 (pergunta 13) |
| S14 ACL de `private\` | 6.2, 9.5 |
| S15 `agent-paths` restrito | 4.4 |
| S16 direção da evidência | 4.5 (regra 4) |
| S17 Node mínimo | 9.5 (conferência por recurso: `--use-env-proxy`, `--use-system-ca`) |
| S18 `ssam_friction` | seção 5, 4.1, 10.7 |
| S19 gramática dos ponteiros | 6.4 |
| S20 pendentes por token | 2.3 |
