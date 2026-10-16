# Conectar ao Studio aberto

A sessão começa com os Studios normais já abertos (Service Studio e/ou ODC Studio) e UMA chamada:

```powershell
.\ssam connect            # todo Studio aberto das faixas servidas, O11 e ODC
.\ssam doctor
```

MCP: `ssam_connect {}`. Sem `lane`, a chamada olha todos os Studios abertos das faixas que esta pasta serve e anexa
cada um que ainda não tem bridge: O11 pelo conector descrito abaixo, ODC pelo `attach` do ODC (cada ODC Studio tem o
seu pipe). Antes, pergunta a cada bridge se ela já responde, sem a espera de 10 s do pipe ODC (uma tentativa curta de
400 ms e o `auth-status`, que a bridge responde mesmo ocupada). A resposta traz, por Studio,
`{lane, pid, target, attached, alreadyAttached, tenant, account}` e `reconnectNeeded`: `false` quando nada precisou ser
anexado (a segunda chamada de uma sessão já conectada). `ok` fala só pelo alvo: o `pid` pedido, ou o único Studio de
cada faixa (no O11, também o que a porta da faixa já serve). A falha de outro Studio aparece na entrada dele e não
derruba a chamada; com vários Studios de uma faixa e sem `pid`, todos os ODC são anexados e `ok` diz se algum ficou
conectado (o O11 pede `pid`: uma porta por faixa).

`--lane o11|odc` (MCP `{lane}`) restringe a uma faixa; `--pid <PID>` escolhe o alvo quando há mais de um Studio. A
seleção não é feita pelo módulo ativo, pelo tenant, pelo título da janela ou pelo diretório de um clone. O servidor MCP
recarrega sozinho quando a fachada ou o catálogo mudam (`server.reloadedAt` no doctor); só uma mudança em
`facade/launch.mjs` ou `facade/friction-*.mjs` pede reconectar o MCP. Isso nunca exige reiniciar o Studio.

Uma entrada MCP por servidor: duas entradas para a mesma raiz SSAM sobem dois servidores sobre as mesmas pastas. O
`configure-mcp` recusa a segunda (`DUPLICATE_MCP_ENTRY`) e diz o nome da que já existe.

Service Studio sem janela principal (a pessoa fechou o Studio, e uma janela escondida do Service Center de um bridge
antigo manteve o processo vivo): o SSAM nunca escolhe esse processo, trata como velho o registro de conexão que aponta
para ele, e o `ssam_doctor` o lista em `windowless: [{pid, code: STUDIO_WINDOWLESS, fix}]`. O Studio com janela é o da
faixa. O bridge novo fecha a janela do Service Center junto com a janela principal (`ScWindowLifetime`), e o processo
termina. O SSAM nunca fecha nem encerra um Studio.

## Trabalho em andamento

Conectar não salva, valida, publica, fecha, reabre ou altera módulos. Não usa teclado/mouse nem troca o login.
Um módulo com erros e alterações não salvas continua elegível para conexão. O handshake consulta apenas
`ping`, `bridge_manifest` e `ui_alive`. A saúde da conexão não prova a validade dos módulos.

Se já houver uma bridge compatível respondendo no processo escolhido, ela é reutilizada. Caso contrário,
o conector prepara uma bridge e um hook em uma pasta nova de `kernel/.local/runtime-connect/` e usa
`DiagnosticsClient.ApplyStartupHookAsync` no processo em execução. A instalação não recebe arquivos.
O hook inicia o trabalho numa thread própria e nunca propaga falhas para o Studio.

As dependências OutSystems vêm da instalação selecionada, sem redistribuição. A bridge nova é compilada
contra essa instalação, com saídas e intermediários isolados. Nenhuma DLL carregada é sobrescrita.
O cliente usa `Microsoft.Diagnostics.NETCore.Client` 0.2.731102, o mesmo pacote Microsoft/MIT já adotado
pelo ODC. O hook em si usa somente bibliotecas do .NET.

## Escritas no mesmo Studio: fila

Duas escritas nunca rodam juntas no mesmo Studio. Desde o pacote atritos 2 (A08), a segunda espera a vez em vez de
ser recusada. Código: `platforms/odc/facade/studio-write-lock.mjs`.

- A fila vale entre processos: duas sessões MCP no mesmo Studio entram na mesma fila, por ordem de chegada.
- Cada pedido é um arquivo em `<raiz da faixa>/.local/locks/<faixa>~q<seq>.queue`, com `{pid, tool, enqueuedAt, seq}`.
  Nunca os argumentos nem as palavras do usuário.
- A espera tem limite: `SSAM_WRITE_QUEUE_MS` (padrão 240000, abaixo do timeout do cliente MCP).
- Na vez, a escrita roda e devolve o próprio resultado. Quando esperou, a resposta traz
  `queue: {position, waitedMs, holder: {tool, pid, startedAt}}`.
- Estourou o limite: `STUDIO_WRITE_QUEUE_TIMEOUT`, com `holder`, `position` e a leitura de estado do Studio
  (`o11_studio {command:"status"}` ou `studio_status`). Nada daquela escrita rodou.
- Cancelar a chamada tira o pedido da fila na hora (`CANCELLED`, `outcome:"not-sent"`).
- Pedido de processo morto, velho (3 h) ou deixado por este processo sai da fila sozinho.
- Leituras nunca entram na fila. Abrir Users, OutSystemsUI ou System é recusado antes do Studio (não espera).
- Uma escrita feita dentro de outra escrita da mesma chamada roda na hora (não espera por si mesma).
- Por módulo (pacote atritos 3, C07):
  - `o11_data` (insert, update, delete) grava pela sessão do bridge, sem aba e sem modelo. A chave dele é a faixa
    `o11-data-<faixa>` mais o módulo do pedido, nunca a do Studio. Duas escritas no mesmo módulo ficam em série; as
    outras correm junto com uma entrega.
  - O publish (ODC e O11) troca, depois do merge e do save, a trava do Studio pela do módulo
    (`narrowStudioWrite`, arquivo `<faixa>~<id>~m-<hash do módulo>.lock`). Enquanto ele publica, uma escrita de outro
    módulo roda; uma do mesmo módulo, ou sem módulo conhecido, espera.
  - Uma escrita na fila passa à frente de outra só quando a outra espera a trava de um módulo que ela não toca.
- Build e apply (pacote atritos 3, lane wp): `o11_deliver` e `studio_deliver` constroem sem a trava (captura pela chave,
  kernel e builder no pool de build) e só entram na fila no primeiro passo que escreve no Studio (merge). Duas entregas
  do mesmo módulo ficam em série pela guarda do módulo (`<faixa>~b-<hash do módulo>.guard`). Detalhes e campos da
  resposta (`phases`, `BUILD_QUEUE_TIMEOUT`): `docs/AGENTES-EM-PARALELO.md`.

## Identidade e retomada

`kernel/.local/connections/ss4.json` (ou `ss5.json`) registra PID, instante de criação, instalação, porta e
caminho da autoridade local. Não contém senha, token nem chave. Os comandos da raiz passam a usar esses
caminhos. Comandos vivos verificam a seleção antes de executar e recusam um processo substituído.

Esse registro é a seleção de Studio de tudo: da fachada (`laneEnvironment`, que o worker usa) e dos scripts
(`kernel/scripts/lanes.py`). A ordem é a mesma nos dois: primeiro o registro, depois `ANVIL_STUDIO_DIR`, depois a
cópia "Anvil {porta}" da faixa. `python kernel/scripts/lanes.py --json` mostra a origem em `selection`.

As portas 4516/4536 continuam sendo as faixas de conexão. Se a porta já pertencer a outro processo,
o conector recusa sem encerrar nenhum deles. Para conectar outro Studio simultaneamente, selecione a
faixa livre com `ANVIL_LANE=ss5` antes do comando.

## Worker da faixa

- Um worker ocioso de outra instalação na porta da faixa é reciclado: recebe `shutdown` e um novo sobe para a instalação
  selecionada. Ocupado, ele continua rodando para quem o usa, e o job desta sessão roda num processo frio.
- Parar um worker (instalação diferente, kernel mais velho, `kernel/scripts/anvil_worker.py stop`, `build.py`) pede o
  `shutdown`. Se o worker aceitou e o mesmo processo (o pid que o ping informou para a porta, com o mesmo horário de
  criação; na fachada, também a imagem `dotnet`) segue vivo 10 s depois, aquele pid é encerrado e a saída é esperada. Um pid cujo horário
  de criação mudou é de outro processo e nunca é tocado; um `shutdown` recusado não para nada.
- O worker sem nenhum comando por `ANVIL_WORKER_IDLE_MINUTES` minutos (padrão 240; `0` desliga) sai sozinho. Ping não
  conta como trabalho. Um pedido que chega nesse instante recebe "reciclando, não executado" e o cliente sobe outro.
- `scripts/build.ps1` nunca inicia worker (sempre `--no-start`; `-NoStart` continua aceito) e termina com `ssam warm`,
  que constrói (ou acha no cache) o índice do discover de cada faixa. O primeiro `ssam_discover` da sessão não o
  constrói. Com a lista gravada da mesma release, o MCP conecta antes da montagem completa e aquece índices, workers habilitados e fatos do doctor em segundo plano, 5 s depois de subir (`SSAM_NO_WARM=1` desliga).

Uma tentativa de attach enviada é registrada antes da chamada em `.anvil/runtime-connect/` do usuário.
Resposta perdida exige consultar os recibos da tentativa; o conector não envia outra automaticamente.
Uma bridge já carregada mas sem resposta também não é substituída. O erro aponta para investigação,
nunca para fechar ou descartar trabalho.

Requisitos: Windows, .NET 8 ou posterior no Studio, endpoint de diagnóstico acessível, permissões locais
compatíveis e SDK .NET disponível para preparar o conector. Atualizações de Studio ainda precisam de
compatibilidade da bridge; isso não promete suporte a todas as versões históricas ou futuras.

## Service Center pela sessão do Studio

Com o Studio conectado, as ferramentas de Service Center (`o11_service_center_session`, `o11_service_center_read`,
`o11_service_center_write`; CLI `ssam service-center`) usam a sessão desse Studio, inclusive SSO, pelos verbos `sc_session`,
`sc_api`, `sc_web` e `studio_login` da bridge (contrato em `_notes\scp\CONTRATO.md` do integrador). O script acha a bridge
pelo registro `kernel/.local/connections/<faixa>.json` desta conexão (porta, PID e pasta da autoridade) e recusa se o PID
na porta não for o do registro (`STUDIO_NOT_CONNECTED`: conectar de novo).

- API do Studio (SOAP, server.api, `/ServiceCenter/rest`): cada chamada usa o login do Studio dentro do processo dele.
- Páginas `.aspx`: a janela web do próprio Studio; cada página é lida por `fetch` da mesma origem dentro do Studio. Com a
  bridge que anuncia `sc_web:login`, a janela fica sempre oculta e loga sozinha com a entrada
  `SSAM/O11/<host>/ServiceCenter` do cofre (para conta OutSystems: e-mail e senha), lida dentro do Studio e digitada só no
  formulário de login do próprio host ou de `id.outsystems.com`. Sem entrada (ou com login recusado), abre o prompt
  privado do SSAM, a única janela que o usuário vê. Bridge anterior: `action=web-sign-in` mostra a janela e o usuário
  entra nela uma vez (SSO).
- Studio conectado sem login no host: `action=sign-in` mostra o diálogo de login do próprio Studio.
- Sem Studio aberto: a credencial do cofre do Windows com o login de formulário, e sem ela o prompt privado que grava no
  cofre. Com Studio aberto, o prompt só abre para o login da janela oculta do Service Center; os demais caminhos pedem
  para conectar (`ssam_connect`).

Esses verbos existem só na bridge nova. Uma bridge já carregada sem eles responde `STUDIO_BRIDGE_OUTDATED`: a versão nova
entra por uma nova conexão (Studio aberto pelo atalho do SSAM), nunca trocando a DLL carregada.

## ODC

`odc attach --pid <PID>` já carrega a bridge no ODC Studio normal em execução. O conector O11 descrito acima
não promove nem recompila a bridge ODC.

Em 29/09/2026, a tentativa no ODC aberto foi bloqueada pelo Windows antes do attach: `0x800711C7`,
eventos Code Integrity 3033/3077 sobre `ODC3.Bridge.Client.dll`. A política de assinatura deve ser resolvida
pelo administrador/gestão de aplicações. Reiniciar o Studio não resolve esse bloqueio; nenhuma política
foi alterada ou contornada.

A verificação separada `ssam package run --operation version` no operacional também recusou o pacote:
`External dependency changed: odc:OutSystems.Model.dll`. É uma divergência entre a dependência instalada e
a dependência validada pelo pacote; não comprova perda de suporte ao ODC. Essas duas entradas estão bloqueadas
no estado observado. Nenhum arquivo ODC operacional foi editado nesta tarefa.

## Validação

- O11 real 11.55.90.65230: conexão à instalação normal, PID 464 mantido, bridge existente reutilizada e UI responsiva.
- Build da bridge contra essa instalação: zero erros; avisos já existentes no código/referências do projeto.
- Teste de integração: processo .NET separado aberto sem bridge, hook aplicado depois da abertura,
  PID e conteúdo em memória preservados com `unsaved=true` e três erros simulados; identidade incorreta recusada.
- Regressão: 18 testes Node de seleção, handshake, registros e MCP/CLI; três testes Python de instalação/worker;
  um teste de integração de attach tardio. Todos aprovados (22 no total).

O teste isolado exercita o mecanismo de attach e o hook, não o Model API real. O carregamento inicial da bridge
completa em um O11 real aberto sem bridge ainda requer essa condição; não se fecha o Studio atual para produzir
a prova. Merge/publicação não foram executados e continuam com seus gates próprios.

Testes reproduzíveis (sequenciais):

```powershell
node --test tests/runtime-connect.integration.mjs
node --test --test-concurrency=1 platforms/odc/facade/tests/studio-connect.test.mjs platforms/odc/facade/tests/lanes.test.mjs tests/workspace.test.mjs
python -m unittest discover -s kernel/tests -p test_runtime_connection.py
```
