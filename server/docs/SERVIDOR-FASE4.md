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

### Worker O11 por cliente

- Cada cliente pode ter um worker O11 residente só dele. Ele serve as chamadas O11 que vão ao kernel (`o11_job`/`ssam_job`
  lane o11, `o11_deliver` e os outros verbos do `createWorkerFirstRunner`). Os builds do `o11_deliver` também usam esse
  worker: uma chamada por vez, as outras rodam frias.
- Ele sobe com o mesmo ambiente do processo frio daquele cliente (porta e chave do relay, `TEMP` e pasta no workspace),
  mais o perfil de memória do servidor, e atende só o `tokenId` dele.
- A primeira chamada de cada cliente (e a primeira depois que o worker parou) roda fria na hora. O worker sobe em segundo
  plano e atende a próxima chamada. Nenhuma chamada espera a partida de um worker nem a saída de outro.
- `SSAM_O11_WORKERS_MAX` (padrão 2, para a KVM 2; 0 desliga) conta também os workers que ainda estão saindo. Sem vaga, o
  ocioso usado há mais tempo cede a vaga, mas só depois de `SSAM_O11_WORKER_MIN_IDLE_MS` (padrão 120000) sem uso. Se
  nenhum pode sair, a chamada só roda fria. `SSAM_O11_WORKER_IDLE_MS` (padrão 600000): ocioso esse tempo, para.
- Perfil de memória, definido pelo servidor e nunca pelo cliente. O worker recebe o ambiente frio mais só estas variáveis:

  | Variável do servidor | Padrão | Variável no worker |
  | --- | --- | --- |
  | `SSAM_O11_WORKER_BASE_CACHE` | `off` | `ANVIL_BASE_CACHE=off` (ou `on` com `ANVIL_BASE_CACHE_ENTRIES=1` e `ANVIL_BASE_CACHE_MB=<MB>`) |
  | `SSAM_O11_WORKER_HEAP_MB` | 1536 | `DOTNET_GCHeapHardLimit` (bytes em hexadecimal; 0 não define) |
  | `SSAM_O11_WORKER_MAX_COMMANDS` | 1000 | `ANVIL_WORKER_MAX_COMMANDS` |
  | `SSAM_O11_WORKER_IDLE_MS` | 600000 | `ANVIL_WORKER_IDLE_MINUTES` (o tempo ocioso mais 5 min) |

- `SSAM_O11_WORKER_RSS_MB` (padrão 1200; 0 desliga): depois de cada chamada o servidor lê o `VmRSS` do worker em
  `/proc/<pid>/status`. Acima do limite, o worker sai depois da chamada, nunca no meio. No Windows não há leitura.
- Saída de um worker: se o ping ainda mostra o processo que o servidor subiu, ele recebe `shutdown`. Se não mostra (outro
  pid, sem ping, falha na partida), o servidor termina o próprio processo e não manda nada com a chave do cliente.
- Resultado desconhecido (pedido escrito sem resposta): nunca é repetido. O worker não recebe mais nada, o servidor espera o
  ping dizer que ficou livre (até o tempo da própria chamada) e só então manda `shutdown`.
- A resposta mostra `via: "worker"`; quando rodou frio, o campo `worker` (ou `workerNote`) diz por quê.
  `ANVIL_WORKER=0` deixa tudo frio, como antes.

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

## 7. 22º envio do produto (`servidor/fase4-22`)

Merge de `consolidacao/main` `04ac63b9` (mesma árvore de `publicar/main` `0891629e`). Um conflito, no overlay
`scripts/release/overlay/kernel/src/Anvil.Cli/Program.cs.patch`, recapturado sobre o `Program.cs` do merge.

- Recusa única: `studio_deliver` e `o11_deliver` capturam o módulo pelo mesmo caminho de antes (agente, relay e bridge
  fina) e o kernel do servidor recusa uma vez com todos os problemas de todas as fases. O Studio do cliente só vê a captura.
- Resumo do módulo: `ssam_map {view:"digest"}` roda nos leitores do servidor sobre a captura que já está no workspace
  (`ws:`). O resumo fica no índice de módulos do servidor e a resposta não mostra caminho do servidor: a apresentação
  hospedada esconde também `SSAM_MODULE_INDEX_ROOT` e `SSAM_READER_CACHE_ROOT` quando ficam fora do checkout e do perfil.
- `ssam_reference check-job` com `base` declarada no job: hospedado, só o job é lido (`verifyRan:false` e o motivo).
  A base declarada seria resolvida no servidor (fixture da suíte ou qualquer caminho). A entrega faz todas as fases.
- Bridges e agente iguais aos da `servidor/fase4` (ODC `v48`): o pacote do agente atual continua valendo.
- O ponta a ponta (`hosted-e2e-processes.mjs`, passo 9g) confere as duas recusas e o resumo nas duas faixas
  (83 de 83). O Studio ODC falso captura o app neutro com bytes reais (`odcModule.json`).
- Do produto, sem correção aqui: numa entrega ODC que compilou, o campo `phases` da recusa (lista de fases) é trocado
  pelos tempos da faixa wp (`studio-write-lock.mjs`). Cada problema continua com a sua fase.

## 8. 23º envio do produto (`servidor/fase4-23`)

Ramo `servidor/fase4-23`, worktree `C:\Users\andre\SSAM-Hybrid-servidor-wt\fase4-23`, a partir de `servidor/fase4-22`
(`1fbfa377`). Merge de `integracao/liberacao23-20261010` `cd7e4f11`: `consolidacao/main` `04ac63b9` mais as faixas do
23º (patch por nome e job parcial, pacote de trabalho do discover com o Service Studio da faixa, índice rico com
`ssam_map` search/uses). O protótipo do job compacto ficou fora (revertido em `cd7e4f11`). O servidor no ar continua na
`fase4-22`: a troca é a da seção 2, pela integradora.

Três conflitos:
- `platforms/odc/facade/job-runner.mjs`: os imports dos dois lados (`withNamedPatches` e os do workspace hospedado).
- `platforms/odc/facade/ssam-reference.mjs`: o `check-job` mantém o motivo hospedado da base declarada (22º) e toda
  resposta passa por `named()` (`jobSha256`, `nextBasedOn`, `partial`, patches por nome).
- `scripts/release/overlay/kernel/src/Anvil.Cli/Program.cs.patch`: recapturado com `stage.mjs edit`/`capture` (faixa W).
  A forma de release de cada lado (o `Program.cs` com o próprio overlay) fez merge de 3 vias sem conflito. O merge de 3
  vias dos `Program.cs` sem overlay é igual ao `Program.cs` do merge. `stage check --from-worktree`: 53 overlays, ok.

Imagem: `docs/LEITURA-RAPIDA.md` (medidas do índice rico) e `kernel/AGENTS.md` citavam capturas de clientes
(`hosted-image-denylist` falhou, 7 achados). As capturas viram O11-A/B/C e ODC-A/B, como no 22º, mais O11-D e O11-E para
as duas fixtures do kernel. Os números são os mesmos.

### O que muda no modo hospedado

- **Patch por nome e job parcial** (`studio_deliver`, `o11_deliver`, `ssam_job`, `o11_job`): `/job` e `/basedOn/job` já
  eram caminhos do workspace. Toda resposta com job traz `nextBasedOn` no `ws:`: o job que rodou (por exemplo
  `ws:inbox/<job>.json`) e cada job corrigido em `ws:odc/.local/jobs/inline/` (ODC) ou `ws:o11/jobs/inline/` (O11). O
  diário do patch também fica no workspace: `<ws>/odc/journal` (`studio_deliver`), `<ws>/odc/.local/journal`
  (`ssam_job` e `ssam_reference` ODC) e `<ws>/o11/journal` (O11). Um `o11_deliver` entregue também traz o `nextBasedOn`
  (`hosted-roots` atualizado).
- **`ssam_reference check-job {basedOn, patch?, job?}`** (novo): o gate trata `/query/basedOn/job` e `/query/job` como
  caminhos do workspace quando a consulta tem essa forma. Antes, um `basedOn.job` ou um job parcial com caminho absoluto
  do servidor chegava ao handler (bastava o sha256 de um arquivo do servidor para copiá-lo para o workspace). Um job
  parcial em texto JSON não é caminho. Um job inline (sem `basedOn` nem `patch`) é o próprio job. Com base declarada,
  continua lendo só o job (motivo hospedado do 22º).
- **`ssam_map` search/uses**: `target` aceita uma lista. O gate só resolvia `/target` como texto, então um caminho do
  servidor dentro da lista (fixture da suíte, captura de outro cliente) chegava ao leitor. Agora `/target/*` é confinado
  item a item. Nome de módulo fica como está, e um nome na lista exige o agente. O índice rico fica no índice de módulos
  do servidor (`<servidor>` na resposta) e cada captura sai como `ws:`.
- **`ssam_discover {app, packet:true}`**: o resumo do módulo é lido pelo leitor do kernel do servidor sobre a captura
  `ws:` (ou capturada pelo agente, quando `app` é um nome). O gate tirava nomes de clientes de toda resposta do discover.
  Um cliente cujo próprio módulo tem um desses nomes recebia `<cliente omitido>` na seção `module` do pacote, no corte que
  a relê e em `next.deliver.arguments.module` (e, desde o 22º, no `context` de `app`). `scrubDiscover`
  (`hosted/evidence.mjs`) mantém `app`, `context` e, no pacote, `module`, o corte dele e `next.deliver` como vieram da
  captura do cliente. A evidência de terceiros continua fora. Os catálogos do dono (capacidades, exemplos, regras,
  ferramentas) continuam sem nomes de clientes.
- **Service Studio do discover O11 (W3)**: hospedado, o registro de conexão é o do cliente (`executor.o11Connection()`),
  com `studioDir` do kernel do servidor. Depois vem `ANVIL_STUDIO_DIR`. O W3 lia também o registro do Windows
  (`reg.exe query`) direto do `discovery.mjs`, e o `seam-guard` falhou: acesso à máquina fora da costura. A leitura foi
  para `studio-locate.mjs` (localizador atrás da costura) e responde `null` numa chamada hospedada, sem rodar nada. Fora
  dela (aquecimento, CLI local) nada muda. `hosted-roots` confere: nenhum `reg.exe` hospedado, Studio do registro de
  conexão.
- Nada novo recusa por ser hospedado: as quatro novidades funcionam sobre o `ws:` do cliente.
- Divergência do produto: `discovery.mjs` e `studio-locate.mjs` diferem da `consolidacao/main` só nessa leitura do
  registro. Um próximo merge que mexa no `o11StudioDir` deve manter a leitura em `studio-locate.mjs`.

### Pacote do agente

Não muda. Bridges ODC (`v48`) e O11 (completa e fina), gancho, `kernel/query-test`, `studio/shared`, `studio/engine`,
`agent/` e `scripts/agent-pack.ps1` estão iguais aos da `servidor/fase4-22`. O `Builder.csproj` ganhou o
`ModuleRichIndex.cs` (lado do servidor).

### Testes desta entrega

Build: `setup-dev.ps1 -Yes -NoUserEnv -SkipInstall -SkipMcp -SkipDoctor` (sem shutdown de worker e sem porta), com
`ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1` e os workers do `.ssam-workspace.json` trocados só localmente para
19517/19537/19547.

- `Anvil.Bridge.Thin.Tests` 110/110, `Bridge.Tests` 149/149, `Builder.Tests` 7/7.
- `Anvil.Tests` e `Anvil.Tests.Odc` filtrados nas áreas do 23º (`ModuleRichIndex|ModuleDigest|ModuleIndex|ModelReading|PrimeiraCerta`):
  47/47 e 26/26.
- Linha do servidor (node): `agent-hub`, `hosted-*` (12 arquivos), `http-server`, `fase4-server`, `fase4-wp-load`,
  `server-tokens`, `public-signature-drift` e `hosted-image-denylist`: 154/154.
- Fachada dirigida da linha (seção 5: `executor`, `seam-guard`, `app-urls`, `pa3-*`, `kernel-delivery`,
  `studio-create-app`, `studio-connect`, `lanes`, `pacote-laneE-responses`): 200/200 em 31 arquivos.
- Fachada nas áreas do 23º e nos arquivos do merge (`module-rich`, `patch-por-nome`, `pacote-trabalho`,
  `discover-studio`, `job-patch`, `job-runner`, `mcp`, `o11-cycle`, `pacote-laneB-job-patch`, `ssam-integration`,
  `pa2-f4-queue`, `ssam-reference`, `module-map`, `module-digest`): 138/138.
- `agent/tests`: 64/65. `ps1.test.mjs` falhou uma vez numa rodada com carga (o agente parou com código 1) e passou
  sozinho 3 de 3 na cabeça: intermitente. A falha que fica é anterior ao 23º: `drift.test.mjs` ("o11-wire.mjs carries the frozen block of
  o11-bridge.mjs") falha igual rodado sozinho numa worktree destacada de `servidor/fase4-22` `1fbfa377`. A cópia do
  agente (`agent/lib/o11-wire.mjs`) ficou atrás dos `TIMEOUTS` de `o11-bridge.mjs` desde o 20º envio (`d7293c74`:
  publish com 45 s de settle, `close_module`). Corrigir muda o pacote do agente: fica para a integradora.
- Ponta a ponta com Studios falsos (`hosted-e2e-processes.mjs`): 96 de 96, os 83 do 22º mais o passo 9h.
  - Patch por nome e job parcial no `studio_deliver` e no `o11_deliver`, com `nextBasedOn` no `ws:`. Os Studios só veem
    capturas e o módulo O11 aberto não muda.
  - `check-job {basedOn, patch}` hospedado. Um `basedOn` na pasta do servidor dá `PATH_OUTSIDE_WORKSPACE`.
  - Pacote de trabalho nas duas faixas.
  - `search` sobre captura `ws:` e `uses` sobre lista com captura e nome do módulo (capturado pelo relay e pelo agente,
    só leitura). Um caminho do servidor na lista é recusado pelo gate.
  - Rode com `ANVIL_ODC_FEATURES_DIR` apontando para o cache de features do ODC Studio da máquina (o perfil do dono no
    teste é uma pasta temporária). Sem isso, as etapas ODC que compilam falham com "ODC Studio feature cache not found".

## 9. 24º envio do produto (`servidor/fase4-24`)

Ramo `servidor/fase4-24`, worktree `C:\Users\andre\SSAM-Hybrid-servidor-wt\fase4-24`, a partir de
`servidor/fase4-23-linux` (`b37715e1`: o 23º com as 4 correções de Linux). O roteiro é o `PLANO-24-PRODUCAO` (fase B).
O servidor no ar continua no 23º. A troca é a das fases C a G do plano, pela integradora.

Commits:
- `f57933d9`: merge de `integracao/juncao-24` `02b71765`. É a junção do 24º (`bd970835`), as correções da junção
  (`90cd3426`) e o patch do `OdcFeatures.cs` (`02b71765`), com os mesmos bytes do `b37715e1`. Base comum `cd7e4f11`.
- `7f4f8e66`: bridge ODC `v96`.
- `d1a15fea`: faixa hospedada (`fase4-24/hospedado`, `34bf1d01`).
- `f166d0a1`: bridge O11 fina e agente (`fase4-24/fina`, `a3f361fc`).
- O commit desta seção: passo 9i do ponta a ponta, guarda da imagem e este texto.

O Texto do SSAM entra depois, como diferença à parte (24.1). O worker O11 por cliente entrou em `fc44b403`
(`fase4-24/worker` `be83a579` = SSAM-MCP `9661871`). O que entrou depois dele está em "Juntado em 12/10", no fim desta
seção.

### Conflitos

O merge do produto teve 19, resolvidos pela tabela 5.1 do plano. Fica a costura hospedada da linha, e os corpos do 24º
entram em volta dela.
- `.gitattributes` e `portal/runtime/odc3-context.mjs`: união.
- `facade/catalog/tools.json`: versão do 24º, com os exemplos sem nome de cliente da linha.
- `facade/lib.mjs`: o `requestFile` do 24º (raiz da bridge) só vale no uso local. No hospedado, o pedido vai para o
  workspace do cliente e o espelho o leva ao agente (R4). `profiles` nulo no hospedado. `reference-producers` entra em
  `OPEN_MODULE_COMMANDS`.
- `service-center/auth.mjs`, `bridge.mjs` e `index.mjs`: fluxo novo do 24º com as guardas da linha reescritas sobre ele.
- `facade/ssam.mjs`: corpo do 24º com o portão da linha por fora.
- `portal/runtime/access.mjs`: corpo do 24º com as recusas hospedadas.
- `cognito-login.mjs`, `client-content.test.mjs` e `PortalCommands.cs`: versão do 24º.
- `portal/tests/access.test.mjs`: união.
- `Bridge.csproj`, `StartupHook.cs`, `client/Program.cs` e `weave-spec.json`: a bridge do 24º com as cópias da linha.
- Overlays `ScProtocol.cs.patch` e `Anvil.Cli/Program.cs.patch`: recapturados com `stage.mjs edit/capture`.
  `stage check --from-worktree`: 53 overlays, ok (de novo na cabeça deste commit).

O merge das duas faixas teve 1 conflito, numa linha de `docs/FASE2-AGENTE.md` (§5). As duas tiraram o mesmo caractere
de controle antigo de jeitos diferentes. Ficou o texto da fina. As seções de cada faixa (§4.8 de uma, §5 e §6.4 da
outra) entraram as duas.

### O que muda no modo hospedado

- **12 ferramentas novas** (plano 2.1). `studio_reference_producers` é do agente (comando `reference-producers` da
  bridge, só leitura). `odc_mcp_connection`, `odc_mcp_import` e `odc_a2a_connection_delete` alcançam o tenant só pela
  sessão do Studio do cliente. `odc_a2a_connection_plan` roda no servidor (não autentica). As 4 só de API Client
  (`odc_native_package`, `odc_generated_code`, `odc_asset_source` e `odc_asset_revision`) e as 3 do depurador
  (`ssam_debug_server`, `ssam_debug_client` e `ssam_debug_matrix`) respondem `HOSTED_UNAVAILABLE`. As de API Client
  trazem `cause:"API_CLIENT_ONLY"` e uma continuação para o que a sessão do Studio faz.
- Totais de `hosted/tools.json`: 95 ferramentas (90 de `createSsamServer`, 4 do gancho e `ssam_friction`). Servidor 23,
  agente 33, tenant-agente 22, indisponível 17. No ar, o `tools/list` sem o gancho passa de 79 para 91.
- **R1, o portão confina o que roda.** A camada de entrada do 24º (`tool-input.mjs`) corrige nomes de campo (`targt`
  vira `target`). O portão conferia os argumentos crus e não via o caminho. Agora o `ssam.mjs` passa o `argsOf` ao
  portão, e o handler recebe os argumentos já resolvidos.
- **D2, op `prototype` recusado.** Em `o11_deliver`, `studio_deliver`, `ssam_job` e `o11_job`, antes de qualquer
  captura: `HOSTED_UNAVAILABLE`, `cause:"PROTOTYPE_SOURCE_LOCAL"`. A chave é `HOSTED_PROTOTYPE_OP` em `hosted/policy.mjs`.
- **Service Center** só por `sc_http`, a sessão HTTP do Studio do cliente, sem janela. Perfil privado, janela de
  credencial, `authPrompt`, `sc_private_http*`, SSO, protocolo de identidade e LifeTime são recusados antes de tentar
  (`HOSTED_STUDIO_SESSION_ONLY` ou `HOSTED_PROMPT_UNAVAILABLE`). Os registros do `solution-download` vão para
  `ws:o11/service-center/downloads`.
- **Portal** pela sessão headless do Studio (`portal-session`). `select-profile`, `auth:"portal-credential"`,
  `portal-private-*`, `portal-api-client-fixture-cleanup` e `portal-upload` são recusados, e os pipes privados nunca
  abrem. O HTTP direto do servidor (`odc3-context.mjs`) recusa. Os pedidos de `odc_read`, `odc_write` e `odc_portal_*`
  ficam em `ws:odc/journal/portal/requests` (R4).
- `odc_configurations` com segredo móvel usa o cofre do cliente pela bridge dele. `authorizationContext` tem de estar na
  área visível do workspace.
- Um servidor sem bridge ODC compilada (a imagem Linux) sonda o pipe do cliente com a `odcBridge` do kernel.

### Imagem: a guarda de nomes de cliente

A guarda `hosted-image-denylist` falhou depois do merge: 223 arquivos do contexto nomeavam um cliente. Correções:
- `.dockerignore`: `docs/PORTAL-*`, `docs/SC-*` e `docs/PROTOTIPO-NATIVO.md` ficam fora da imagem. São propostas,
  provas ao vivo e passagens de bastão da linha SC/Portal e o desenho do importador. O servidor não lê nenhum deles.
- `portal/catalog/portal-capabilities.json`: os rótulos de evidência dizem `corporate` no lugar do nome do cliente.
  O teste do catálogo acompanha.
- `kernel/src/Anvil.Core/Kernel/Prototype/RuntimeDomTable.cs` e `facade/debug-lock-inventory.mjs`: o texto de
  evidência e um comentário sem o nome do cliente.
- Três jobs do depurador (`debugger-client-variable-*`, ODC) rodavam sobre a captura do cliente. Passam a usar a
  fixture anonimizada `insurance-reactive-r8.oml` (espace `InsuranceApp`). `OdcJobTests`: 3 de 3. A mesma correção
  cabe no produto.

`public-signature-drift` também falhou: a bridge v96 liga `kernel/src/Anvil.Bridge/PrivateHttpContext.cs`. O teste
aceita esse arquivo (namespace `Ssam.PrivateTransport`, sem tipo do kernel) como compartilhado das duas bridges. Qualquer
outro arquivo do kernel continua fora da bridge.

### Pacote do agente

Muda.
- Bridge ODC `v96`. A bridge da linha é a `v95` do produto com o CSRF e as cópias da `v48`: outra DLL, outro número.
  Nenhuma ref da integração, do servidor, do operacional ou do SSAM-MCP cita v96 a v99. As worktrees vistas usam `v95`
  (junção), `v84` (SC/Portal do Codex), `v55` (operacional) e `v48` (SSAM-MCP).
- Bridge O11 fina com `sc_http` (23 verbos). `sc_web` e `sc_http` vão para o `ScHttpHandler`, e `studio_login` responde
  uma recusa tipada. Entra `sc_http:studioSession`. Saem `sc_web:hidden`, `sc_web:login` e `studio_login`.
  `sc_private_http*` fica fora.
- Agente `0.3.0`: `reference-producers` no `odc.pipe` e `sc_http` no `o11.bridge` (`args.outFile` recusado). O bloco
  copiado de `o11-bridge.mjs` voltou a ser igual (o `drift.test.mjs`, vermelho desde o 20º, passa). Com o transporte
  do 0.2.1 e o `net.probe`, o pacote do 24º leva o agente `0.3.1` (ver "Juntado em 12/10").
- Pacotes antigos continuam aceitos (`odcBridgeAccepted`). Degradam com códigos tipados: o Service Center responde
  `STUDIO_BRIDGE_OUTDATED` e `reference-producers` recebe `COMMAND_NOT_ALLOWED` do agente antigo.
- O ZIP novo ainda não foi gerado (fase C do plano).

### `kernel.json`

`{"o11":"11.55.91","odc":"1.7.27","odcBridge":"v96","odcBridgeAccepted":["v48","v45"]}`. No rollback, volta o do 23º:
`{"o11":"11.55.91","odc":"1.7.27","odcBridge":"v48","odcBridgeAccepted":["v45"]}`.

### Testes desta entrega

Build: `setup-dev.ps1 -Yes -NoUserEnv -SkipInstall -SkipMcp -SkipDoctor`, com `ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`,
`SSAM_NO_WARM=1` e os workers do `.ssam-workspace.json` trocados só localmente para 22517/22537/22547. A comparação é
com `b37715e1` (o 23º da linha), extraído por `git archive` numa pasta de rascunho e compilado do mesmo jeito.

- `Anvil.Bridge.Thin.Tests` 114/114, `Bridge.Tests` 311/311 e `Builder.Tests` 7/7 (no `b37715e1`: 110, 149 e 7).
- `Anvil.Tests` e `Anvil.Tests.Odc` filtrados em `ServiceCenter|Pa2F8|ThinBridge|ModuleIndex|ModelReading`: 171/171 e
  18/18 (no `b37715e1`: 150 e 16). Mais `PrototypeCss` 25/25 (o `RuntimeDomTable.cs`) e os 3 jobs do depurador sobre a
  fixture anonimizada (`OdcJobTests`) 3/3.
- Node, em `platforms/odc`: `agent-hub`, `hosted-*` (17 arquivos), `http-server`, `fase4-server`, `fase4-wp-load`,
  `server-tokens`, `public-signature-drift`, `executor`, `seam-guard`, `odc-access`, `access.test` do portal,
  `service-center*`, `studio-write-lock`, `prototype-op` e `job-runner`: 42 arquivos, 655 testes, 654 ok e 1 pulado por
  desenho (a regra 8 do `prototype-op`, que só roda sem a faixa de render). No `b37715e1`: 32 arquivos, 407/407.
  Nenhuma falha nova. `portal-capabilities` 25/25 junto das guardas.
- `agent/tests` e `tests/prova-verbos.test.mjs`: 70/70. No `b37715e1`, 68/69: o `drift.test.mjs` agora passa.
- Ponta a ponta com Studios falsos (`hosted-e2e-processes.mjs`): o passo 9i foi escrito aqui, mas só rodou de verdade
  na cabeça de "Juntado em 12/10" (117 de 117, com o passo do job composto de `ec19d87f`).
  - `studio_reference_producers` chega ao Studio ODC falso como `reference-producers <Módulo>`, só leitura.
  - `o11_service_center_read {action:"db-connections"}` pela fina: `sc_session` e `sc_http` com a chave do agente,
    `auth.path` `studio-http`. Nenhum `sc_web`, `studio_login` ou transporte privado.
  - `odc_mcp_connection readiness` pela sessão headless do Portal (`portal-session fetch`): cada pedido em
    `ws:odc/journal/portal/requests` e lido pelo agente do espelho dele.
  - `HOSTED_UNAVAILABLE` nas 3 do depurador e nas 4 de API Client (`API_CLIENT_ONLY` com continuação). Nada chega a um
    Studio.
  - Op `prototype` recusado nas 4 ferramentas de job (`PROTOTYPE_SOURCE_LOCAL`, `not-sent`).
  - `ssam_map {targt:<caminho do servidor>}` dá `PATH_OUTSIDE_WORKSPACE`; `{targt:<ws:>}` roda como `target`.
  - Cliente C com o pacote v48 (listas do agente do 23º, bridge ODC v48, fina do 23º): o hub aceita pelo
    `odcBridgeAccepted`, o pipe pedido é o da v48, `reference-producers` recebe `COMMAND_NOT_ALLOWED` e o Service Center
    responde `STUDIO_BRIDGE_OUTDATED` com a continuação `ssam_connect`.
  - Rode com `ANVIL_ODC_FEATURES_DIR` apontando para o cache de features do ODC Studio da máquina, como no 23º.

### Fora desta entrega

- O Texto do SSAM (24.1): `feat/texto-ssam*` e `feat/tx*` não entraram.
- Pacote v96, cópia para o SSAM-MCP, imagem, ensaio e troca na VPS (fases C a G do plano).
- Prova ao vivo com o dono: SC por `sc_http`, `studio_reference_producers` e Portal headless na máquina dele.

### Juntado em 12/10 (velocidade, prazos, painel)

Cada um num merge `--no-ff` próprio, sobre `fc44b403` (24º + v96 + hospedado R1/R3/R4 + recusa do protótipo, inclusive
em job composto + fina com `sc_http` + agente 0.3.0 + worker O11):
- `899022a3`: `fase4-24/prazos` (`ec757019`). O produtor aberto e sem alterações no Studio é ligado pela aba
  (`o11-open-producer.mjs`), a leitura do ambiente que o cliente do próprio Studio cortou responde
  `ENVIRONMENT_CALL_CUT` (`EnvironmentCut.cs`), o relé hospedado dá 330 s ao `environment_session` e o log do hub
  nomeia método e operação. Conflito em `o11-cycle.mjs`: ficou o fluxo do protótipo do 24º, com o `runInput` dos
  produtores ligados pela aba no build e na entrega.
- `cab7fdf0`: `fase4-24/tokens` (`934abab1`): `renew`, `setLanes`, códigos de erro e trava de escrita do
  `server-tokens.mjs` para o painel do dono. Sem conflito.
- `5016e2a3`: `fase4-24/vel-hosted` (`1b42c8cb`, com `fase4-24/agente-rede` `ec11f911`; nasceu de `b37715e1`). Job
  inline no hospedado, `ssam_doctor {network:true}` e o transporte do agente 0.2.1 (prazo por parte, conexão nova na
  nova tentativa). Conflitos: `AGENT_VERSION` (0.3.0 e 0.2.1 viram `0.3.1`; `fase4.test.mjs` e o rebaixamento do
  cliente C no ponta a ponta acompanham), `AGENTE-CLIENTE.md` (os dois itens), `agent-hub.mjs` (os verbos do log e a
  sonda de rede, os dois) e `ssam.mjs` (o texto JSON do job vira objeto antes dos padrões do protótipo). O
  `hosted/policy.mjs` fundiu sozinho: ficam as correções do portão de `73449b8e`, `34bf1d01` e `ec19d87f`.
- `4c5ffdd2`: o tipo `net.probe` na lista fechada do agente (`patch-kinds.diff` da faixa), ao lado das listas do 24º.
- `a505fde5`: `integracao/velocidade` (`1b26c2b4`, base `02b71765`). `JobNormalizer` (o motor corrige erros de forma
  em vez de recusar e lista o que mudou), um job por módulo, leituras menores, resumo no "entregue", as normalizações na
  fachada, reaproveitamento da captura, `open` sem a checagem de referências, create-app sem pré-leituras e a nova
  tentativa de leitura do ambiente (`ENVIRONMENT_UNREACHABLE`). Conflitos: `ConnectedEnvironment.cs` (o registro da
  operação de prazos em cada tentativa da nova leitura), `o11-build-phase.mjs` (os dois imports) e dois overlays:
  `Anvil.Cli/Program.cs.patch`, refeito por merge de 3 vias de cada lado (fica o `PdfText` sem nome de cliente), e
  `OdcFeatures.cs.patch`, o da linha. `stage.mjs check --from-worktree`: 53 de 53.

Correções que as faixas deixaram para a linha:
- `ff27a1cd`: a fina serve `list_open_modules:model_sha256` e `open_module:references_check_optional` (o build
  hospedado reaproveita a captura em vez de subir o mesmo modelo) e descreve a falha do ambiente como a completa
  (`DescribeParityTests`).
- `f42fedcf`: as regras hospedadas dizem um job por módulo, inline e compacto, e que a resposta lista as
  `normalizations` (já aplicadas; nunca reenviar para desfazer).
- `68c16e5c` e `67d7f36c`: `ENVIRONMENT_CALL_CUT` e `ENVIRONMENT_UNREACHABLE` sem tratamento duplo. A nova tentativa
  só existe no `ConnectedEnvironment.Call`: uma leitura que falhou na rede vai uma vez mais, uma escrita nunca, e uma
  chamada que o cliente do próprio Studio encerrou pelo prazo dele (o SendTimeout de 60 s do WCF) também nunca. Uma
  entrega responde um código só: a captura de produtor embrulha a leitura inalcançável como `ENVIRONMENT_CALL_CUT` com
  `cut.repeated`, e uma leitura inalcançável em outro ponto da entrega, antes de qualquer escrita, vira o mesmo corte.
  A fachada nunca repete. O `EnvironmentCut.cs` continua compilando no kernel ODC (`IEnvironmentReadFailure`).

Agente: `0.3.1` (0.3.0 do 24º, transporte do 0.2.1 e o tipo `net.probe`), com a bridge ODC `v96` e a fina com as duas
capacidades novas. O ZIP ainda não foi gerado (fase C do plano). `kernel.json` não muda.

Testes na cabeça destes commits (`ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`, `SSAM_NO_WARM=1`, `setup-dev.ps1` com as
portas dos workers trocadas só localmente para 24617/24637/24647):
- `Anvil.Bridge.Thin.Tests` 116/116, `Bridge.Tests` 311/311, `Builder.Tests` 7/7.
- `Anvil.Tests` filtrado em `ServiceCenter|Pa2F8|ThinBridge|ModuleIndex|ModelReading|Delivery|Environment|Normalizer|Open|Producer`:
  463/463. `Anvil.Tests.Odc` no mesmo filtro: 25 ok e 1 pulado.
- Node: 61 arquivos (`hosted-*` com 20 arquivos, `agent-hub`, `http-server`, `fase4-*`, `server-tokens`, `executor`,
  `seam-guard`, `job-runner`, `o11-*`, `studio-*`, `prazos-*`, `agent/tests` e `tests/prova-verbos.test.mjs`), cada
  um sozinho: 598/598, nenhum nome de falha (portanto nenhum novo em relação a `fc44b403`).
- Guardas de segurança: `hosted-input-rename`, `hosted-prototype`, `hosted-tools` (totais sem mudança), `hosted-policy`,
  `hosted-roots`, `hosted-mirror` e `hosted-image-denylist`: 66/66.
- `hosted-e2e-processes.mjs` executado, com `ANVIL_ODC_FEATURES_DIR` no cache de features do ODC Studio da máquina:
  117 de 117, inclusive todos os passos do 9i e o cliente C com o pacote v48.

Fica em aberto: a prova de que um job inline no hospedado não carrega caminho fora do workspace do cliente nos campos
que o kernel lê de dentro do job (`data.source`, `file`, partes de job composto, documentos) e de que as recusas de
protótipo e de job composto valem também para o job inline em texto JSON. Não entrou nesta rodada.

## ODC Studio 1.7.28

Em 12/10/2026 o ODC Studio do dono e o do Pedro se atualizaram sozinhos para 1.7.28.10850. A produção
(`prod-20261012-a857a1e`, `kernel.json` com `"odc":"1.7.27"`) recusa a faixa ODC deles com `STUDIO_VERSION_MISMATCH`.
O O11 não muda (11.55.91). Ramo `fase4-24/odc1728`, sobre `a415531d` (a produção).

### Bundle
- `studio-bundle.ps1 -Lane odc` (SSAM-MCP `server/r24-odc1728`, de `a857a1ef`), lendo o 1.7.28.10850 instalado:
  `odc-studio-1.7.28.10850.tar.gz`, 196 arquivos, sha256
  `cbe778bdabf6940fb5ff3a2eb63935f6075a2b7a7768ff85431bc73f63151e8c`. Fica em `C:\t\odc28\installers`, ao lado de uma
  cópia do bundle O11 11.55.91 (`e9f0751a…`). Build da imagem com `STUDIO_INSTALLERS_DIR=/c/t/odc28/installers`.
- A lista `studio-odc.txt` não muda: os 196 arquivos existem no 1.7.28, as referências de assembly deles não pedem outro
  arquivo da pasta do Studio e não há plugin novo.
- Do 1.7.27 para o 1.7.28 mudaram 68 dos 196 arquivos, entre eles `OutSystems.Model*.dll`: o modelo vai de
  13.1431.3.60000 para 13.1436.1.60000.

### Bridge ODC v97
- A v96 foi compilada contra o 1.7.27. A v97 é a mesma bridge compilada contra o 1.7.28: outra DLL, outro número. Nenhuma
  ref da integração, do servidor, do operacional ou do SSAM-MCP cita `ODC3.Bridge.v97` a `v99`.
- Os 4 lugares: `Bridge.csproj`, `StartupHook.cs`, `bridge/client/Program.cs` e `weave-spec.json`. `stage.mjs check
  --from-worktree`: 53 de 53.
- Quebra binária do 1.7.28: `IReferencesManagerService.RefreshSpecificReferencesByKey` ganhou um sexto parâmetro
  opcional (`nonSharedProducerKeys`). Uma bridge compilada contra o 1.7.27 aponta para o método de cinco parâmetros, que
  o 1.7.28 não tem mais. No 1.7.28, o `refresh-references <Módulo> --producer <Biblioteca>` dela falha ao ligar a
  chamada (`MissingMethodException`). Conferido nos metadados: a v96 e a v48 têm só essa referência quebrada; a v97 e o
  kernel ODC não têm nenhuma.
- Por isso o executor hospedado recusa esse comando antes de enviar, para pacote com bridge abaixo da v97 num ODC Studio
  1.7.28 ou mais novo: `STUDIO_BRIDGE_OUTDATED`, "Nothing was sent", com o pedido do pacote novo
  (`hosted/agent-executor.mjs`, `bridgeApiBreak`). O resto do pacote v96 continua funcionando.

### `kernel.json`
`{"o11":"11.55.91","odc":"1.7.28","odcBridge":"v97","odcBridgeAccepted":["v96","v48","v45"]}`. O pacote v96 do Pedro
continua aceito. No rollback, volta o do 24º.

### Kernel, fixtures e testes
- Catálogo `kernel/catalog/odc/verify-messages-1.7.28.10850.json` (`verify-catalog`): 576 ids, 5 novos e nenhum
  removido (`AgentManifestOnlyOneProtocolInputMustBeFilled`, `BreakpointMinWidthOutOfOrder`, `DuplicateBreakpoint`,
  `InvalidCssPropertyValueInCustomStyle`, `InvalidExtraSmallBreakpointMinWidth`). Nenhum é de segurança.
- `kernel/tests/fixtures/odc/blank-*.oml` refeitas com os comandos do `OdcBlankModuleTests` (mesmas chaves, modelo
  13.1436.1.60000). O sidecar do `blank-crossdevice.oml`, a base neutra do `ssam_job` ODC hospedado, ganhou sha256 e
  `capturedAt` novos.
- Testes que fixam a versão do servidor: kernel falso `1.7.28`; o caso de outra versão passa a ser um cliente ainda no
  1.7.27. Imagem, `.env.example`, compose e READMEs: `ODCStudio-1.7.28.10850.exe` e `odc-studio-1.7.28.10850.tar.gz`.
- Jobs de cobertura ODC: nenhum muda. Fase 2 inteira (489 jobs) e, da fase 1, os 11 que não existem na fase 2 mais os 29
  que tocam tema, estilo, breakpoints e agente, todos pelo CLI compilado contra o 1.7.28. Fora o que já era recusado, só
  3 jobs saem diferentes do carimbo antigo (`cov-data-staticentityrecord-del`, `cov-processes-timeofday-one-set` e o
  `recon-*` da captura de cliente da fase 1). Os 3 dão o mesmo resultado no CLI do 24º sobre o bundle 1.7.27: são regras
  do kernel posteriores ao carimbo, não do 1.7.28.

Testes (`ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`, `SSAM_NO_WARM=1`, `ANVIL_ODC_FEATURES_DIR` numa cópia do cache de
features, workers do `.ssam-workspace.json` trocados só localmente para 28517/28537/28547). A comparação é com
`a415531d`, extraído por `git archive` e compilado do mesmo jeito contra o 1.7.28:
- `Anvil.Tests.Odc` filtrado em `Odc|Job|Pa|Prototype|Coverage|ScreenHtml|Flow|Ddl`: 783 ok, 1 pulado, 0 falhas. No
  `a415531d`: 781 ok e 2 falhas, exatamente as do 1.7.28 (`TheVerifyIdManifestIsTheInstalledOdcCatalog` e
  `TheBlankFixturesWereSavedByTheInstalledModel`).
- `Bridge.Tests` 311/311 e `Builder.Tests` 7/7 (iguais no `a415531d`).
- Node (`platforms/odc/facade/tests`, `platforms/odc/tests`, `platforms/odc/portal/tests`, `agent/tests`, `tests` e
  `scripts/release/license`, um processo por arquivo): 602 arquivos, 5121 testes, 4991 ok, 64 falhas, 31 pulados. No
  `a415531d`: 5114 testes, 102 falhas. Nenhum nome de falha novo: os 2 que só falharam na cabeça (o índice do
  `discovery` reaproveitado por identidade, que mudou porque a bateria do kernel escrevia no `test-work` ao mesmo
  tempo, e o MCP da raiz em `tests/workspace.test.mjs`, tempo esgotado) passam sozinhos; `pacote-trabalho` também
  passa sozinho (17/17). As outras falhas são as mesmas do `a415531d` e nenhuma é do 1.7.28: DPAPI, git da cópia,
  carimbos O11 do `test-work` que esta bateria só ODC não refaz (`catalog-a-*`, `catalog-b-ui`), tempo com a máquina
  cheia, e o C26 de `fase4-server.test.mjs`, que falha igual sozinho no `a415531d`.
- `hosted-bridge-version`, `hosted-sc-portal` e `hosted-agent-executor` juntos: 21/21.
- `hosted-e2e-processes.mjs` (servidor com `kernel.json` 1.7.28/v97, cliente no 1.7.28 e o cliente C no pacote v48):
  117 de 117.

Fica em aberto no 1.7.28: o pacote v97 do agente, a imagem com este bundle, o cache de features do 1.7.28 na imagem, a
prova ao vivo do `refresh-references --producer` da v97 num ODC Studio 1.7.28 (o sexto parâmetro vai no padrão) e os
pinos do depurador em `facade/debug-matrix/native-limits.json` que citam DLLs do 1.7.27 (`OutSystems.Model.dll`
13.1431.3, `OutSystems.ServiceStudio.PluginAPI.dll` 13.1431.3): no 1.7.28 a matriz os mostra como
`stale-installed-assembly` até alguém refazer aquelas provas.

## Service Studio 11.55.92

Em 12/10/2026 o Service Studio do Pedro está no 11.55.92.65269. A produção (`prod-20261012-a857a1e`, `kernel.json` com
`"o11":"11.55.91"`) recusa a faixa O11 dele com `STUDIO_VERSION_MISMATCH`. Ramo `fase4-24/o11-115592`, sobre `a415531d`
(a produção). O ODC deste ramo continua no 1.7.27 (o 1.7.28 é o ramo `fase4-24/odc1728`).

### Instalador e bundle
- Instalador oficial `ServiceStudio-11.55.92.65269.exe`: 325.319.112 bytes, sha256
  `1d82f514e8ab7f78ba5dcef8eb618b6088a1793c1993db424f247c59d6efba49`, Authenticode válido (OutSystems, Inc.). Só lido,
  nunca executado: o estágio de extração do Dockerfile (`nsis_extract.py`) tira dele a pasta do Studio.
- Bundle `o11-studio-11.55.92.65269.tar.gz` (`studio-bundle.ps1 -Lane o11 -Studio <pasta extraída>`): 145 arquivos,
  sha256 `67b44feddd2784e453b81a32294cea23d48448be57f4301e422b9ae1122e79cf`. O estágio `studio-o11` dá os mesmos 145
  arquivos pelo instalador e pelo bundle.
- A lista `studio-o11.txt` não muda: os 145 arquivos existem no 11.55.92, e a única referência de assembly nova
  (`System.Collections.Concurrent`, do `Avalonia.Remote.Protocol`) é do runtime compartilhado.
- Do 11.55.91 para o 11.55.92 mudaram 57 dos 145 arquivos. `OutSystems.Model*.dll`: versão de arquivo 12.185 para
  12.187, AssemblyVersion continua 12.0.0.0. `ServiceStudio.*` e plugins: 11.55.91.65258 para 11.55.92.65269. Avalonia
  11.3.9 para 11.3.22.
- Imagem deste repositório, `.env.example`, compose, READMEs e scripts de prova: `ServiceStudio-11.55.92.65269.exe` e
  `o11-studio-11.55.92.65269.tar.gz`. O `server/Dockerfile` do SSAM-MCP ainda fixa a 11.55.91: o build da imagem da 92
  passa `SERVICE_STUDIO_INSTALLER`, `SERVICE_STUDIO_SHA256`, `SERVICE_STUDIO_BUNDLE` e `SERVICE_STUDIO_BUNDLE_SHA256`.

### Kernel
- O código compila contra o 11.55.92 sem mudança: `Anvil.Cli`, `Anvil.Bridge`, `Anvil.Bridge.Thin` e os testes, 0 erros,
  nenhum CS0618, CS1705 ou MSB3277.
- Catálogos lidos do Studio: `kernel/catalog/functions-11.55.92.json` (`anvil functions --out ... --docs
  docs/functions.md`) e `kernel/catalog/verify-messages-11.55.92.json` (`anvil verify-message --out ...`). São iguais
  aos do 11.55.91: 121 funções e 472 ids, nenhum id novo ou removido. Entrou também `functions-11.55.91.json`, que
  faltava no `a415531d` (o `FunctionCatalogTests` falhava no 11.55.91). Cada Studio tem o seu arquivo e o kernel lê o
  do Studio ligado: o 11.55.91 continua funcionando.
- `kernel/docs/functions.md` regenerado: só o cabeçalho muda (11.55.87 para 11.55.92).

### `kernel.json`
`{"o11":"11.55.92","odc":"1.7.27","odcBridge":"v96","odcBridgeAccepted":["v48","v45"]}`. Junto com o ramo do ODC
1.7.28, `odc` e as bridges ODC seguem as dele. No rollback, volta o do 24º.

Um servidor serve uma versão do Service Studio. O hub recusa pacote com outro `o11BuiltFor` (`AGENT_PACK_MISMATCH`), e o
agente recusa um Studio de versão diferente da fina dele (`STUDIO_VERSION_MISMATCH`). Por isso o Pedro precisa de um
pacote com a fina compilada contra o 11.55.92 (`o11BuiltFor` `11.55.92`), que ainda não foi gerado. Os clientes que
ficarem no 11.55.91 continuam num servidor 11.55.91 até o desenho de várias versões.

### Testes
`ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`, `SSAM_NO_WARM=1`, builds com `-p:SSDir` e `ANVIL_STUDIO_DIR` na pasta
extraída do 11.55.92. A comparação é com `a415531d`, extraído por `git archive` e compilado do mesmo jeito contra o
11.55.91 instalado (só lido). As duas árvores com as fixtures ignoradas pelo git (`outsystems-ui.oml` e
`outsystems-ui-web.oml`).
- `Anvil.Bridge.Thin.Tests`: 116/116 nos dois.
- `Anvil.Tests` filtrado em
  `Delivery|Job|Logic|Spec|Preflight|ThinBridge|ModuleIndex|ModelReading|ServiceCenter|Pa2F8|Environment|Normalizer|Producer|Open|HtmlVisual|Screen`,
  mais `FunctionCatalog`, `SurfaceTests`, `MessageExpectationTests`, `MessageToleranceTests`, `VerifyAnchorTests`,
  `ElementWidgetMapTests` e `PublishLogTests`: 1540/1540 no 11.55.92. No `a415531d` sobre o 11.55.91: 1539 ok e 1 falha (`CatalogInRepoMatchesTheStudio`, sem
  `functions-11.55.91.json`).
- Sem os catálogos novos, o `a415531d` falha no 11.55.92 só em `CatalogInRepoMatchesTheStudio` e
  `VerifyIdsAndHintsMatchTheInstalledPublicCatalog`. Com eles, os dois passam no 11.55.92 e no 11.55.91.
- Node, em `platforms/odc`: `o11-*`, `hosted-o11-worker`, `job-runner` e `kernel-delivery` (16 arquivos): 255/255 nos
  dois.
- Sem prova ao vivo: nenhum Studio foi aberto.

## Imagem interina: Service Studio 11.55.92 e ODC Studio 1.7.28

Decisão do dono (12/10/2026): a faixa O11 hospedada vai para o 11.55.92 e a ODC para o 1.7.28, numa imagem de uma versão
por faixa, antes do servidor de várias versões (`C:\t\multiver\DESIGN.md`, revisão 3, O.6.1). Ramo `fase4-24/combinada`:
`a415531d` + `fase4-24/odc1728` (`c48074be`) + `fase4-24/o11-115592` (`e0c8a2ef`) + `fase4-24/qualidade` (`1b2ce8fe`).

### O que a imagem traz (itens 1 a 10 do O.6.1)

1. **Versões declaradas.** `ENV SSAM_IMAGE_O11=11.55.92 SSAM_IMAGE_ODC=1.7.28` e os rótulos `ssam.kernels.o11` e
   `ssam.kernels.odc` (`docker/ssam-server/Dockerfile`; no SSAM-MCP, `server/Dockerfile`). O build para se o
   `ServiceStudio.Framework.dll` de `/studio/o11` ou de `/studio/odc` tiver outra versão
   (`node platforms/odc/facade/kernel-image.mjs check-image`).
2. **Recusa ao iniciar, por faixa.** Se o `kernel.json` nomeia outra versão, a faixa fica desligada:
   `KERNEL_UNAVAILABLE` com `cause: "KERNEL_VERSION_MISSING"`, e o log tem `kernel-version-missing` (`lane`, `kernel`,
   `image`, `studio`, `reason`). A outra faixa continua. Sem as variáveis (o PC do dono) nada muda.
   A faixa desligada vale para todas as ferramentas dela, também as só do servidor (`ssam_job`, `ssam_map`,
   `ssam_discover`, `ssam_reference`, `o11_job`, `odc_search_operations`): o portão hospedado responde a mesma recusa
   antes do agente e de qualquer caminho (`kernelLaneOff` em `hosted/policy.mjs`). Só os relatórios de estado
   (`ssam_doctor`, `studio_doctor`) respondem. O aquecimento do servidor pula a faixa desligada.
3. **`kernel.json` v1.** O da interina é
   `{"o11":"11.55.92","odc":"1.7.28","odcBridge":"v97","odcBridgeAccepted":["v96","v48","v45"]}`. Um `kernel.v2.json` é
   ignorado (`kernel-v2-ignored`).
4. **Pacote do agente.** A fina O11 é compilada contra a pasta do 11.55.92 (`ANVIL_STUDIO_DIR` = a pasta extraída do
   instalador assinado, com `ServiceStudio.exe`; nunca a cópia de faixa): `scripts\agent-pack.ps1 ... -ExpectO11 11.55.92`
   para se a pasta for de outra versão ou for a cópia de faixa. ODC: bridge v97. O sha256 da fina fica no `pack.json`
   (`o11Bridge.sha256`): ela vira uma bridge de campo (O.5).
   - **Por que a fina do 11.55.92, e não a do 11.55.91.** Prova em `C:\t\multiver\compat-run`: a fina compilada contra o
     11.55.91 liga no 11.55.92 (0 avisos), e a compilada contra o 11.55.92 não liga no 11.55.91 (11 falhas
     `assembly-version`). Mesmo assim o pacote leva a do 11.55.92: o hub recusa `o11BuiltFor` diferente do kernel
     (`AGENT_PACK_MISMATCH`) e o agente 0.3.x recusa um Studio de versão diferente da fina. A aceitação "para cima" de uma
     fina antiga (D1) só vale com agente 0.4.0 e prova ao vivo. A falha no 11.55.91 não importa aqui: a interina não serve
     o 11.55.91.
5. **Caches.** Índice de módulos `v1/o11` e `v1/odc`, cópias dos leitores O11 (`readers/ss4`) e do prefetch
   (`readers-prefetch/ss4`; o desenho diz `readers/ss4-prefetch`, que também é apagado): esvaziados no primeiro início
   com outra versão da faixa (`kernel-cache-reset`, carimbo `kernel-studio.json` na raiz do índice). Uma faixa desligada
   conta como carimbo inválido: as raízes dela são esvaziadas e o carimbo dela sai, e a próxima subida com o par certo
   esvazia de novo. Assim nenhum índice feito por outra versão fica no volume. O deploy e o rollback
   também os esvaziam à mão (DEPLOY §7.1 e §8 do SSAM-MCP). Os leitores ODC já são separados por geração (builder e
   Studio). O cache de bases dos workers O11 fica em memória e já tem a versão na chave (`BaseModelCache`).
6. **Catálogos.** `kernel/catalog/functions-11.55.92.json` e `verify-messages-11.55.92.json` (iguais aos do 11.55.91,
   tirando o campo `Studio`), `verify-messages-1.7.28.10850.json` do ODC.
7. **Telemetria.** Só nomes de evento novos (`quality`, `kernel-version-missing`, `kernel-cache-reset`,
   `kernel-v2-ignored`). `kernel`, `warm` e `agent-*` mantêm o formato (testes em `kernel-image.test.mjs` e
   `privacy-record.test.mjs`). O `agent-call` ganhou, na linha de qualidade, o `command` opcional do `odc.pipe` (só da
   lista do agente); o painel lê só `kind`, `ok`, `code` e `ms`.
8. **Cliente no Service Studio 11.55.91.** Perde a faixa O11 hospedada até o servidor de várias versões, com qualquer pacote.
   O hub responde `STUDIO_VERSION_MISMATCH` com `cause: "STUDIO_VERSION_NOT_SERVED"`, `served: ["11.55.92"]` e
   `installed: "11.55.91"`, antes de olhar o pacote (desde A-M1: `cause: "STUDIO_UPDATE_REQUIRED"`, o build de cada lado
   e o texto em pt-BR; `docs/FASE2-AGENTE.md` 7). A continuação do `ssam_doctor` diz: atualize o Service Studio para
   11.55.92 ou siga com o SSAM local. As ferramentas só do servidor continuam. O PC do dono (11.55.91) também.
9. **Rollback.** O `kernel.json` vem do registro da imagem (`server/deploy/release-record.json` do SSAM-MCP), nunca de um
   arquivo solto, e a conferência do par roda antes do `up -d` (`server/deploy/kernel-pair-check.mjs`). DEPLOY §8.
10. **Conferência do par no deploy.** A mesma conferência roda antes da primeira subida da interina. DEPLOY §7.1.

### Também nesta linha
- Auditoria e `server.log`: o nome da ferramenta só da lista do catálogo hospedado; outro vira `?`.
- Seção Privacidade do `docs/AGENTE-CLIENTE.md` igual ao que o servidor grava: retenção do log (depende da limpeza
  semanal), primeira máquina e alertas sem prazo, campos do Hello que ficam só na memória. `privacy-record.test.mjs` liga
  cada campo gravado ao texto.
