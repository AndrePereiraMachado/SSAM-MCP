# Agente SSAM na sua máquina (guia do cliente)

## O que é

- Você usa o SEU cliente MCP (Claude Code ou outro) com o SEU LLM, na SUA conta. Ele chama as ferramentas do servidor
  SSAM do dono por HTTPS, com um token.
- O servidor guarda o que é do dono (kernel, catálogo, regras, receitas). **Nenhum LLM roda no servidor.**
- O agente SSAM roda na sua máquina e faz só o que precisa tocar a sua máquina: falar com o ODC Studio e o Service Studio
  que VOCÊ abriu, listar esses processos e ler e gravar arquivos dentro da pasta dele.
- A conexão é só de SAÍDA, da sua máquina para o servidor. Nenhuma porta é aberta na sua máquina.
- Tudo o que usa a sua sessão do Studio (Portal/tenant ODC, Service Center, ambiente O11) roda dentro do SEU Studio. O
  login, os cookies e os tokens do Studio nunca saem do processo do Studio; o servidor recebe só o resultado de cada
  passo.
- Os OMLs viajam entre o servidor e o agente com conferência de sha256. Nunca passam pelo LLM.

## Privacidade: o que o servidor registra sobre o seu acesso

Só o dono do servidor vê o log, a auditoria e o registro de qualidade descritos abaixo. Eles ficam no servidor dele e não são repassados a terceiros.

**Log do servidor.** Para saber quem usa cada acesso e de onde, o servidor grava:

- **Quando o seu cliente MCP abre uma sessão:** o IP de onde você conecta, o nome e a versão do cliente MCP (por exemplo, Claude Code) e o user-agent. O IP é o público que o túnel vê. Muda se você trocar de rede, VPN ou 4G.
- **Quando o agente conecta:** o IP, a versão do agente, o nome do computador, o seu usuário do Windows e um identificador da máquina. O identificador é um hash do `MachineGuid` do Windows com esses dois e não permite recuperá-los. Com o Service Studio ligado ao agente, também a versão, a porta local, o número do processo e a hora em que ele abriu.
- **A cada chamada:** as ferramentas, o tamanho da resposta e o tempo. Numa chamada ao agente, o tipo, o comando (só da lista do agente), o tempo e o código do resultado. Também quando o agente conecta, cai ou volta.

**A primeira máquina fica registrada.** Na primeira conexão do agente, o servidor guarda o nome do computador, o seu usuário do Windows, o identificador e o IP. Se a sua credencial conectar de outra máquina, o acesso continua funcionando, mas o dono recebe um alerta com as duas máquinas e o IP. Trocou de computador? Avise o dono. Trocar de rede, VPN ou 4G não gera alerta de máquina.

Nada além disso sobre a sua máquina é enviado: nenhum arquivo, nenhum histórico, nenhum outro programa. Se você não concordar, não instale o agente e fale com o dono.

**Auditoria e registro de qualidade.** De cada chamada de ferramenta, o servidor guarda só códigos, contagens e tempos. Os códigos vêm de uma lista fechada do SSAM. Um valor fora da lista vira um marcador fixo, como `CODE_UNLISTED`, e só é contado.

- **Em toda linha:** a hora, o identificador do seu acesso, o nome que o dono deu a ele e um resumo da sessão MCP que não permite recuperá-la.
- **A chamada:** a ferramenta, a ação escolhida nela (da lista da ferramenta), a plataforma (O11 ou ODC), a ordem na sessão, a duração, o intervalo desde a resposta anterior e quantas chamadas corriam juntas.
- **O resultado:** se deu certo, foi recusado, ficou incerto ou falhou; o código; o passo em que parou; e se foi `entregue`, `entregue e publicado` ou `criado`.
- **A resposta:** quantos problemas de cada código (por fase, quantos eram avisos, quantos vieram com correção pronta e se a lista foi cortada), quantos avisos (e quantos graves), quantas correções automáticas de cada regra, o tamanho, se veio em páginas e como o servidor a leu.
- **O tempo:** quanto levou cada fase (fila, captura, compilação, Studio, verificação, publicação, ambiente, transferência, rede e o próprio servidor); quantas chamadas ao agente, de que tipo e comando, com quantos bytes, quanto tempo e quantas falhas; quantas vezes o motor rodou e quanto levou.
- **O pedido, só a forma:** como o job veio (no pedido, num arquivo ou na pasta do agente), se usou `basedOn`, `partial`, `closePrevious`, `publish` ou `until`, quantos patches e o tamanho em bytes.
- **A sessão MCP:** quando abriu e fechou, o motivo, quantas chamadas teve e a família do cliente MCP (Claude Code, Codex, Cursor...).

Nada do seu trabalho entra na auditoria nem no registro de qualidade: nenhum nome de módulo, tela, action ou entidade, nenhum job, expressão, mensagem, caminho de arquivo, endereço de ambiente ou texto seu. O dono vê esses números por cliente e somados de todos os clientes, para achar os erros mais comuns e o que deixa o SSAM lento.

**Por quanto tempo.** O dono escolhe por quantos dias guarda cada um desses registros. O padrão guarda o log por 56 dias e a auditoria e o registro de qualidade sem prazo. As cópias de segurança do servidor levam os mesmos arquivos.

**O seu espaço no servidor** (`ws:`) guarda os arquivos do seu trabalho (jobs, capturas, recibos e jornais) e a fila de atritos do seu acesso: de cada chamada, a operação, a plataforma, o resultado, o código, o passo e o tempo, e o texto dos relatos que o seu cliente MCP grava com `ssam_friction`. Você e o dono veem esse espaço.

## O que você recebe do dono do servidor

| Item | Para quê |
|---|---|
| `ssam-agent.zip` | o pacote do agente (código do agente, o Node com a licença dele, bridges dos Studios, `pack.json` com o sha256 de cada arquivo) |
| endereço do servidor (`https://...`) | onde o agente e o cliente MCP se conectam |
| token MCP (`ssam_...`) | vai na configuração do seu cliente MCP |
| credencial do agente (`ssam_agent_...`) | vai no agente, pelo `setup` |

O token e a credencial são diferentes e um não serve no lugar do outro. Cada um é mostrado ao dono uma vez só: guarde os
dois num cofre de senhas, nunca num repositório ou num chat.

## Pré-requisitos

- Windows 10 ou 11.
- Node: não precisa instalar. O pacote traz `agent\node\node.exe` (Node 24, com as opções `--use-env-proxy` e
  `--use-system-ca`) e, ao lado, `agent\node\LICENSE`, a licença do Node, que acompanha o binário. O `ssam-agent.ps1`
  usa esse Node. Só um pacote gerado sem Node (o dono avisa) pede o Node 24 instalado (o `doctor` confere as duas
  opções).
- .NET 10 runtime para o cliente de attach da bridge ODC (`ODC3.Bridge.Client`). Para O11, também o .NET 8 runtime ou
  mais novo para o conector (`Anvil.Connect`).
- ODC Studio e/ou Service Studio na MESMA versão do kernel do servidor (o `ssam_doctor` do seu cliente MCP mostra as duas
  versões). O ODC Studio tem de estar no caminho oficial, `C:\Program Files\OutSystems\ODC Studio\ODC Studio` (o cliente de
  attach só aceita esse).
- Uma pasta para o agente **sem espaço** e **fora de `%LOCALAPPDATA%`**. O padrão é `%USERPROFILE%\SSAM-Agent`; se o seu
  nome de usuário tem espaço, use `C:\SSAM-Agent`. (A bridge ODC divide os comandos por espaços; e processos de apps da
  Store veem um `%LOCALAPPDATA%` diferente, então o Studio não acharia a bridge lá.)

## Instalar

```powershell
Expand-Archive .\ssam-agent.zip -DestinationPath C:\SSAM-Agent
C:\SSAM-Agent\agent\node\node.exe C:\SSAM-Agent\agent\ssam-agent.mjs setup --server https://ssam.exemplo.com --root C:\SSAM-Agent
```

Nos comandos `node ...` deste guia, `node` é o `C:\SSAM-Agent\agent\node\node.exe` do pacote (ou o Node 24 instalado,
num pacote sem Node).

- O `setup` pede a credencial do agente: cole e tecle Enter (ela não aparece na tela). Ou use
  `--credential-file <arquivo>` (e apague o arquivo depois). A credencial nunca vai como argumento, nunca é mostrada e
  fica em `private\credential`.
- Antes de gravar a credencial, o `setup` restringe `private\` ao seu usuário:
  `icacls <pasta>\private /inheritance:r /grant:r "<DOMÍNIO\usuário>:(OI)(CI)F"`.
- O `setup` recusa uma pasta com espaço (peça `--root C:\SSAM-Agent`), um endereço `http://` que não seja da própria
  máquina e uma credencial fora do formato `ssam_agent_...`.
- `--o11-port <porta>` muda a porta local da bridge O11 no seu Service Studio (padrão 4516). Use quando outra
  ferramenta já usa a 4516 nesta máquina.
- Se o PowerShell bloquear scripts, rode os `.ps1` com `powershell -ExecutionPolicy Bypass -File <script> <ação>`.

## Iniciar, parar e conferir

```powershell
C:\SSAM-Agent\agent\ssam-agent.ps1 start     # sobe em segundo plano e espera a conexão (até 30 s)
C:\SSAM-Agent\agent\ssam-agent.ps1 status
C:\SSAM-Agent\agent\ssam-agent.ps1 stop      # parada limpa: avisa o servidor e sai
node C:\SSAM-Agent\agent\ssam-agent.mjs doctor
```

- Sem serviço do Windows e sem administrador. Pid, estado e log ficam em `private\` (`agent.log`, sem nenhum segredo).
- O `start` só diz "conectado" quando o processo que ele iniciou se conectou. Se o agente parar, ele diz por quê:

| Código | Motivo | O que fazer |
|---|---|---|
| 2 | credencial recusada, revogada, vencida ou trocada | peça uma credencial nova ao dono e rode o `setup` de novo |
| 3 | outro agente com a mesma credencial assumiu a conta | deixe um agente só por conta |
| 4 | o servidor não aceita esta versão do agente | peça o pacote atual ao dono |

- Caiu a rede ou o servidor reiniciou? O agente reconecta sozinho (1, 2, 4, 8, 16, 30 s) e continua de onde parou: um
  passo já entregue nunca roda duas vezes.
- Enquanto ele reconecta, as ferramentas respondem `AGENT_RECONNECTING` com `retryAfterSeconds`: o seu LLM repete a
  mesma chamada depois desse tempo. Não é preciso reiniciar nada. Só `AGENT_NOT_CONNECTED` pede para iniciar o agente.
- Desde o agente 0.2.0: um envio de mensagens desiste em 10 s (mais 1 s a cada 64 KiB) e vai de novo; o pong vai num envio
  próprio; um stream sem resposta em 15 s é refeito na hora. Um envio preso não derruba mais o canal.
- Desde o agente 0.2.1: uma troca de rede ou de IP (Wi-Fi, 4G, VPN) no meio de uma tarefa atrasa uma parte de arquivo
  em cerca de 11 s (antes, de 20 a 50 s). Cada parte tem prazo próprio (10 s, mais 1 s a cada 64 KiB) e, sem resposta,
  vai de novo numa conexão nova; conexões paradas há mais de 2 s não são reaproveitadas; uma conexão morta cai em cerca
  de 15 s. Cada nova tentativa aparece em `private\agent.log` como `blob-retry`.
- Desde o agente 0.3.0 (pacote com a bridge ODC `v96`): o Service Center pela sessão do Studio (`sc_http`) e a lista de
  produtores de um módulo ODC (`reference-producers`). Com um pacote mais velho, essas ferramentas respondem
  `STUDIO_BRIDGE_OUTDATED` ou `COMMAND_NOT_ALLOWED`: peça o pacote novo ao dono.
- O agente 0.3.1 (pacote do 24º) junta os dois e responde ao teste de rede do `ssam_doctor {network:true}` (envios
  descartáveis em conexões novas; nada da máquina é lido nem gravado).
- Em primeiro plano, para ver erros na tela:
  `node --use-env-proxy --use-system-ca C:\SSAM-Agent\agent\ssam-agent.mjs run --root C:\SSAM-Agent`.
- O `doctor` confere as opções do Node, a pasta, a integridade do pacote (`pack.json`), a configuração, a credencial
  (sem mostrar), os runtimes .NET, os Studios instalados e se o servidor responde.

## Configurar o cliente MCP

Guarde o token MCP numa variável do terminal (não num arquivo do repositório) e use o exemplo
`docs\exemplos\mcp-cliente-hospedado.json` como `.mcp.json` do seu projeto, trocando `<host>`:

```powershell
$env:SSAM_TOKEN = "ssam_..."
```

```json
{"mcpServers":{"ssam":{"type":"http","url":"https://<host>/mcp","headers":{"Authorization":"Bearer ${SSAM_TOKEN}"}}}}
```

Ou: `claude mcp add --transport http ssam https://<host>/mcp --header "Authorization: Bearer $env:SSAM_TOKEN"`.

Depois, no cliente MCP: `ssam_doctor` mostra o agente conectado e as versões; `studio_attach` liga o ODC Studio aberto;
`ssam_connect {lane:"o11"}` liga o Service Studio aberto. Sem o agente, as ferramentas que precisam da sua máquina
respondem `AGENT_NOT_CONNECTED` e as que rodam só no servidor continuam funcionando.

## O que o agente faz

Só estes 10 pedidos. Qualquer outro é recusado sem rodar nada (`KIND_NOT_ALLOWED`); o servidor nunca manda código,
script ou caminho de DLL.

| Pedido | O que faz na sua máquina |
|---|---|
| `studio.processes` | lista os processos `ODCStudio.exe` / `ServiceStudio.exe` e a versão de cada um |
| `odc.pipe` | manda um comando da lista fechada para a bridge ODC do seu ODC Studio |
| `odc.attach` | carrega no seu ODC Studio a bridge ODC DO PACOTE, com o cliente de attach do pacote |
| `o11.bridge` | manda um método da lista fechada para a bridge O11 do seu Service Studio |
| `o11.connect` | carrega no seu Service Studio a bridge O11 fina do pacote (binários prontos; nada é compilado aqui) |
| `o11.selected` | confere se o Service Studio conectado ainda é o mesmo |
| `file.put` / `file.get` / `file.list` | grava, lê e lista arquivos só nas pastas abaixo |
| `file.sync` | grava de uma vez os vários arquivos de um passo (agente 0.2.0), com as mesmas regras do `file.put` |

- Comandos ODC aceitos: `status`, `wait`, `authorize`, `open`, `snapshot`, `latest`, `check-base`, `preview`, `merge`,
  `publish`, `publish-status`, `publish-log`, `dismiss-dialog`, `close`, `module-info`, `assets`, `consumers`, `create`,
  `create-app`, `templates`, `template-download`, `refresh-references`, `reference-snapshot`, `reference-producers` (os
  produtores que o módulo aberto pode referenciar; só lê, bridge ODC `v96`), `data`, `data-insert`, `data-update`,
  `data-delete`, `portal-call`, `portal-session`, `auth-status`, `stop`, `query-test` (o teste nativo de uma consulta SQL
  ou Aggregate, bridge ODC `v45`; a captura que ele lê também fica na pasta do agente).
- Métodos O11 aceitos (os 23 da bridge fina): `ping`, `bridge_manifest`, `get_active_module`, `list_open_modules`,
  `get_errors`, `open_module`, `close_module`, `publish`, `windows`, `ui_alive`, `close_dialog`, `snapshot_module`,
  `merge_from_oml`, `merge_status`, `environment_session`, `sc_api`, `sc_web`, `sc_http` (o Service Center pela sessão
  do próprio Studio, sem janela), `studio_login` (só responde que falta a sessão do Studio; nunca abre o diálogo de
  login), `sc_session`, `publish_log`, `refresh_references` (o Refresh References do próprio Studio; o Ctrl+Z desfaz),
  `answer_dependencies_dialog` (responde Cancel ao diálogo "Incompatible or missing dependencies found"; depois o servidor
  pede o Refresh References).
- Nunca passam pelo agente: o transporte privado do Service Center (`sc_private_http`) e os comandos privados do Portal
  (`portal-private-*`). Eles usam um cofre e um pipe locais, que não atravessam máquinas.
- A bridge O11 do pacote é a bridge FINA: só as operações primitivas do Studio (abrir e fechar módulo, capturar o
  módulo aberto, o merge nativo de um OML pronto, publicar, a sessão de ambiente, o Service Center, dados, diálogos).
  Ela não leva o kernel do SSAM: toda a lógica roda no servidor. O agente só fala com essa bridge; se o Service Studio
  já tiver outra bridge Anvil carregada (aberto por outro atalho), o `o11.connect` recusa com `ATTACH_FAILED` sem
  carregar nada: feche e abra o Service Studio normalmente.
- Antes de cada passo no Studio, o agente confere a versão do PROCESSO escolhido contra o kernel do servidor
  (`STUDIO_VERSION_MISMATCH`): instalações lado a lado e a atualização automática do ODC Studio não passam. Quando o ODC
  Studio se atualiza sozinho (o 1.7.28, em 12/10/2026), a faixa ODC fica recusada até o dono pôr no servidor o kernel
  daquela versão; o pacote que você já tem continua aceito enquanto a bridge dele estiver em `odcBridgeAccepted`.
- Depois do attach, o agente só usa a bridge O11 que for o arquivo do SEU pacote (sha256 do `pack.json`). Outra bridge
  responde `BRIDGE_VERSION_MISMATCH`: nada mais é enviado a ela; reinicie o Service Studio.
- Um pacote com o gancho de release (o dono avisa) traz `release.json`, `release.sig.jws` e a pasta `studio\o11\`. O
  agente confere a assinatura do pacote antes do attach e grava um único arquivo de pedido em
  `%USERPROFILE%\.ssam-hybrid\data\o11\runtime-connect\<pid>-<início>`; o gancho confere os arquivos de novo antes de
  carregar a bridge. Um arquivo do pacote alterado recusa o attach.
- Escritas do Service Center pela bridge O11 do pacote: sem `corporateHosts` no seu `%USERPROFILE%\.ssam-hybrid\config.json`,
  todo ambiente conta como corporativo, e cada escrita precisa da sua instrução explícita para aquele ambiente.
- A chave da bridge O11 é gerada na sua máquina (`private\authority\bridge.key`) e nunca sai dela.

## O que o agente NUNCA faz

- Abrir porta, aceitar conexão de fora ou rodar um LLM.
- Executar outro programa, script ou comando que não esteja nas listas acima. `attach` pelo `odc.pipe`, `login`,
  `export_*`, `find_element` e `get_flow_nodes` são recusados.
- Ler ou gravar fora das pastas permitidas: caminhos com `..`, absolutos, UNC, fluxos alternativos (`:`), nomes de
  dispositivo e links ou junções que escapam são recusados antes de qualquer acesso. A bridge recebe só caminhos dentro
  da pasta do agente, inclusive os que estão dentro de um manifesto.
- Mandar para o servidor a sua senha, os cookies ou os tokens do Studio, ou a credencial do agente.
- Mostrar a credencial em tela ou log.

## Pastas

```
C:\SSAM-Agent\
  agent\        código do agente            bin\       bridge O11 fina, hook e Anvil.Connect (só O11)
  agent\node\   node.exe e LICENSE (o Node do pacote e a licença dele)
  odc\studio\   bridge ODC e cliente        odc\README.md  marcador da raiz da bridge ODC
  odc\snapshots\  odc\journal\  odc\lab\    dados ODC (espelho do seu espaço no servidor)
  o11\          dados O11 (espelho)         inbox\     arquivos que VOCÊ entrega ao servidor
  private\      config.json, credential, authority\, o11-connection.json, agent.log (só o seu usuário)
  pack.json     id, faixas, versões e sha256 de cada arquivo do pacote
  studio\o11\   só no pacote com gancho de release: hook\Anvil.Hook.h1.dll e bridge\b1\ (a bridge fina)
  release.json, release.sig.jws   só no pacote com gancho de release: a assinatura do dono sobre cada arquivo
```

| O servidor pode | Pastas |
|---|---|
| gravar | `odc\snapshots`, `odc\journal`, `odc\lab`, `o11` |
| ler | as mesmas e `inbox` |

`agent\`, `bin\`, `studio\`, `private\`, `odc\studio\`, `odc\README.md`, `pack.json`, `release.json` e `release.sig.jws`
nunca são lidos nem gravados pelo servidor.

## Entregar um arquivo ao servidor

Ponha o arquivo em `C:\SSAM-Agent\inbox\` e diga ao seu LLM o nome `agent:inbox/<arquivo>` (por exemplo
`agent:inbox/Quotes.oml`). Os jobs não passam por lá: o LLM manda o job dentro da própria chamada (inline, em JSON
compacto), direto ao servidor, sem subida pelo agente. Um job que já está no inbox ainda funciona.
Um caminho absoluto dentro da pasta do agente
(`C:\SSAM-Agent\inbox\job.json`) vale como o mesmo `agent:`; qualquer outro caminho é recusado com o lugar exato onde
gravar. O `ssam_doctor` mostra a pasta (`agent.inbox`). O servidor só lê esse arquivo quando uma ferramenta pede. Os caminhos que as ferramentas
devolvem aparecem como `ws:odc/...`, `ws:o11/...` ou `ws:inbox/...` (o seu espaço no servidor).

## Teste de rede

Entregas lentas ou travando? Peça ao seu LLM `ssam_doctor {network:true}`. Em uns 5 s o agente sobe alguns envios
pequenos e dois de 1 MB, cada um numa conexão nova, e o servidor diz, por saída da sua internet, se as subidas passam.
Exemplo: "uma das suas saídas de internet (177.26.87.x) perde pacotes nas subidas". Isso acontece com roteador de duas
saídas em balanceamento, ou com 5G e celular ancorado. Os bytes do teste são aleatórios e descartados; nada do seu
computador é lido.

## Proxy corporativo e certificados

- Proxy: defina `HTTPS_PROXY` (e, se precisar, `NO_PROXY`) para o seu usuário, por exemplo
  `setx HTTPS_PROXY http://proxy.empresa:8080`, abra um terminal novo e reinicie o agente. O `ssam-agent.ps1` sobe o Node
  com `--use-env-proxy`, que faz o agente usar essas variáveis.
- Se o proxy da empresa recusar as conexões do agente 0.2.1 e o agente 0.2.0 funcionava, defina `SSAM_AGENT_HTTP=fetch`
  para o seu usuário (`setx SSAM_AGENT_HTTP fetch`), abra um terminal novo, reinicie o agente e avise o dono.
- Certificado da empresa (inspeção TLS): instale a CA da empresa no repositório de certificados do Windows. O agente
  sobe com `--use-system-ca`, que confia nesse repositório.
- Rodando `node ... run` à mão, passe as duas opções você mesmo (exemplo na seção "Iniciar").

## Atualizar o agente (pacote novo)

Quando o dono manda um pacote novo (por exemplo, o da bridge ODC `v97`, compilada contra o ODC Studio 1.7.28):

1. `C:\SSAM-Agent\agent\ssam-agent.ps1 stop`.
2. Feche o ODC Studio (a bridge antiga fica carregada até ele fechar; a nova tem outro nome e outro pipe).
3. Extraia o pacote novo POR CIMA da mesma pasta:
   `Expand-Archive .\ssam-agent.zip -DestinationPath C:\SSAM-Agent -Force`. `private\` (configuração, credencial, chave),
   `inbox\`, `odc\` e `o11\` ficam como estavam: o pacote não traz esses arquivos.
4. `C:\SSAM-Agent\agent\ssam-agent.ps1 start` e `node C:\SSAM-Agent\agent\ssam-agent.mjs doctor`.
5. Abra o ODC Studio normalmente e, no seu cliente MCP, chame `ssam_doctor`: `agent.agentVersion` mostra `0.2.0` e a
   faixa ODC fica `ok`. Depois, `studio_attach` (ou `ssam_connect {lane:"odc"}`) carrega a bridge nova.

Não rode o `setup` de novo: a credencial e o endereço do servidor continuam os mesmos. Um pacote velho com o servidor novo
responde `AGENT_PACK_MISMATCH` (o `ssam_doctor` mostra as duas versões).

## Revogação e troca de credencial

- O dono revogou o seu token (ou ele venceu): o agente recebe o aviso e para em até 1 segundo (código 2); as chamadas do
  cliente MCP recebem 403. Nada mais roda na sua máquina.
- O dono trocou a credencial do agente (`agent-rotate`): o agente para (código 2, "rotated"). Rode o `setup` de novo com a
  credencial nova (o resto da configuração continua) e depois `start`.
- Outro agente com a mesma credencial iniciou: o primeiro para (código 3) para não disputar com o segundo.

## Desinstalar

`C:\SSAM-Agent\agent\ssam-agent.ps1 stop` e apague a pasta. Uma bridge já carregada fica no Studio aberto até ele fechar.
