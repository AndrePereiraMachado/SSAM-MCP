# Registro automático de fricção

Estado: implementação revisada e **instalada na raiz operacional em 20/09/2026, 23:08 UTC**.
Novas chamadas CLI e novas conexões MCP pelo launcher raiz já registram operações.
Conexões MCP abertas antes da instalação conservam seu código anterior até reconectar;
não foram interrompidas. Studios, DLLs e seleção de pacote foram preservados.
Prova: `.local/friction-audit/20260920/activation-smoke.json`; inventário e backup em
`.local/friction-audit/20260920/`. Revisão funcional: commits `017b23c` e `b45ff56`.
Não corrige o gate de autoria CSS, não troca a seleção funcional e não faz merge/publicação.

## O que passa a acontecer sem uma anotação da LLM

Os lançadores `ssam` e `odc` da raiz observam cada operação CLI e cada `tools/call` MCP.
Um registro de início é persistido antes da operação; seu término contém resultado, duração,
faixa e identidade observável. A consulta da fila agrupa automaticamente falhas equivalentes.
Isso cobre o servidor operacional e `ssam-functional` quando registrados pelo launcher raiz,
incluindo seus pacotes imutáveis. Não instrumenta uma CLI .NET/Python executada diretamente,
nem `platforms/odc/facade/*.mjs` iniciados sem o launcher raiz. Essas entradas ainda têm os
próprios recibos/journals, mas não devem ser anunciadas como cobertas por esta camada.

Uma operação de entrega pelo fluxo operacional continua sendo atribuída ao fluxo operacional,
mesmo que as leituras anteriores tenham usado um pacote readonly. A identidade do pacote vem
da seleção cuja assinatura SHA256 foi conferida; a admissão continua sendo responsabilidade
do roteador do pacote. A identidade operacional é o hash das fontes da fachada e do observador,
incluindo handlers MCP e roteador de pacote,
**não** prova a identidade de DLLs nativas já compiladas/carregadas.

O MCP ganha `ssam_friction` para consultar `issues` e `task` (e, desde 06/10/2026, registrar `report`).
O servidor readonly ganha somente essa fila local, sem novos poderes de autoria ou Studio.
A resposta original das ferramentas e o exit code original da CLI são preservados.
O fast path `package run` permanece no mesmo processo. O MCP tem um supervisor Node por
conexão; não cria um processo extra por chamada e não reinicia processos existentes.

### Pacote de 05/10/2026 (lane E, C44)

- **Código e etapa da própria resposta.** O registro usa o `code` explícito da resposta (UPPER_SNAKE, no topo ou em
  `error.code`) em vez de `OPERATION_FAILED`, e a etapa de `failed`, `stage` ou `gate` (`snapshot`, `build`, `manifest`,
  `check-base`, `preview`, `merge`, `publish`, `validation`, `equivalence`, `preflight`, `apply`, `verify`, `reconcile`,
  `refresh-references`, `relay`, `connect`, `data`, `debug`, `service-center`). Sem etapa declarada, o prefixo do código
  a dá (`PREFLIGHT_*` → `preflight`, `PUBLISH_*` → `publish`...). Antes, 89 de 89 falhas de job O11 viravam
  `OPERATION_FAILED` sem etapa.
- **Operações novas** com nome próprio: `grant`, `close`, `warm`, `discover`, `map`, `connect`, `evidence`, `reference`,
  `task` e as demais ferramentas de sessão, que antes caíam em `other`.
- **Isolamento.** `SSAM_FRICTION_DIR=<pasta>` grava a fila de uma execução de teste ou bancada fora da fila
  compartilhada `.local/friction`; `tests/friction.test.mjs` limpa a variável e usa pastas temporárias.
- **API direta** (interface I9) para o que não passa pela fronteira MCP/CLI:
  `friction.recordEvent?.({operation, lane, code, step, outcome})` de `facade/friction-store.mjs`; nunca lança e nunca
  muda o resultado de quem chama.
- O processo MCP que os clientes rodam (`facade/ssam.mjs mcp`, como no `.mcp.json`) passa pela fronteira de
  `facade/launch.mjs`; o teste confere a configuração e uma chamada real registrada.

### Pacote de 06/10/2026 (lane F7a, A20 e A31)

**Código antes de `OPERATION_FAILED` (A20).**
- 37% das falhas saíam como `OPERATION_FAILED`. Agora uma tabela única classifica o texto da recusa.
- A tabela fica em `platforms/odc/facade/refusal-codes.mjs`. O shaper das respostas (`responses.mjs`) e esta fila usam a mesma.
- Exemplos: validação do SDK ou do zod → `INPUT_INVALID`; `debug_<x>` → `DEBUG_<X>`;
  `discovery descriptor does not match` → `DISCOVERY_INDEX_INVALID`; pipe da bridge ODC perdido → `BRIDGE_NOT_ATTACHED`;
  `ArgumentException` → `ARGUMENT_INVALID`.
- O texto só é classificado. Ele continua sem ser gravado.
- Na fila, sem código explícito e sem texto conhecido, o registro segue `OPERATION_FAILED`.
- Nas respostas do servidor, toda recusa sem código ganha um: o da tabela, o da etapa (`BUILD_FAILED`) ou o da ferramenta.

**Registro manual pelo MCP (A31).**
- Antes, `ssam_friction` só lia. Uma lacuna sem falha não tinha como entrar na fila.
- Caso real: o ButtonGroup do fragmento html (notas do dono). A sessão caiu para `create` nativo e nada foi registrado.
- Agora: `ssam_friction {view:"report", kind:"gap"|"defect"|"slow", tool, intent, attempted, workaround?, cost?, summary?, taskId?}`.
- `kind`: `gap` (falta forma compacta ou ferramenta), `defect` (resposta errada), `slow` (lentidão).
- O registro vai para `.local/friction/reports/<id>.json`, imutável, schema `ssam-friction-report/1`.
- Ele aponta as últimas cinco operações da mesma sessão MCP: id, operação, código, etapa e hash do recibo.
- Ficam só os campos dados, cada um com limite de tamanho. As palavras do usuário só em `summary`.
- Nunca os argumentos ou as respostas de outras chamadas.
- A leitura devolve os registros: `issues` traz `reports` e `reportsTotal`; `task` traz os da tarefa correlacionada.
- Campo faltando: `REPORT_INVALID` com todos os problemas. Campo desconhecido: `FRICTION_QUERY_INVALID`.
- CLI do desenvolvedor: `.\ssam friction report --kind gap --tool <ferramenta> --intent <texto> --attempted <texto>`.
- A ferramenta deixou de ser só leitura (`readOnlyHint:false`): a escrita é local, sem Studio e sem notificação.

### Pacote de 07/10/2026 (atritos 3, C33)

**Índice diário.**
- Antes, `issues` lia todos os arquivos de operação a cada consulta: 6.000 registros levavam 1,45 s e 23,9 KB.
- Agora cada início e cada fim também gravam uma linha curta em `.local/friction/index/<aaaammdd>.jsonl` (o dia do início).
- `index/.complete` diz que o índice cobre todas as operações. Uma fila antiga (sem índice) é reconstruída do disco uma vez, na
  primeira leitura. Uma gravação do índice que falha apaga a marca, e a próxima leitura reconstrói.
- As linhas só são acrescentadas: uma reconstrução ao lado de um gravador duplica linhas, nunca perde. A leitura fica com a
  primeira linha de cada tipo.
- `issues` lê o índice e devolve por grupo: `count`, `firstSeen`, `lastSeen`, `lastStep` e `lastOperationIds` (os dois
  últimos ids). As operações completas saem de `task` ou do `snapshot`. `max` (ou `limit`) e `offset` paginam os grupos.
- Com 5.000 operações: menos de 300 ms e menos de 8 KB.

**Sessão.** `observeMcp` aceita `sessionId`, o id da sessão MCP do transporte, quando um processo serve várias (o servidor
hospedado). Um id que não é UUID vira um UUID derivado (nunca o id em si). Sem ele, uma sessão por observador, como antes.

**Auditoria.** `auditOutcome(result)` (`facade/friction-store.mjs`) lê `structuredContent.ok` e o `code`. Um `ok:false` sem
`isError` conta como falha, com o código da resposta, senão o da tabela de recusas, senão `TOOL_ERROR`. É para o
`http-server.mjs` da linha do servidor.

## Consulta e correlação

```powershell
.\ssam friction issues
.\ssam friction issues --task-id <identificador>
.\ssam friction task --task-id <identificador> --offset 0 --limit 50
```

CLI usa `SSAM_TASK_ID` quando fornecido; na ausência dele, usa `CODEX_THREAD_ID` se o cliente
o disponibilizar no processo da chamada. A proveniência dessa associação fica registrada.
Clientes que não fornecem nenhuma identidade produzem `correlation: absent`.

No MCP, use `params._meta["ssam/taskId"]`, `arguments.task_id` de um contrato já existente,
ou `SSAM_TASK_ID` fixado para um servidor dedicado. O MCP **não** adota automaticamente
`CODEX_THREAD_ID` do processo inicial: um servidor persistente pode atender várias tarefas.
Não é necessário task ID para registrar falhas; ele é necessário para atribuir com segurança
várias chamadas à mesma tarefa. O adaptador do cliente deve fornecer essa identidade uma vez,
sem exigir que a LLM anote cada operação. Nenhuma configuração MCP é alterada por este código.

Os IDs fornecidos são armazenados como hashes estáveis; consultas recebem o ID original.
O relatório separa soma das durações, união dos intervalos de ferramentas simultâneas e
intervalo observado fora de chamadas concluídas. Esse intervalo **não mede raciocínio**,
não inclui necessariamente o começo/fim do pedido e pode conter espera ou outras atividades.
Operações incompletas e importações históricas são explicitamente separadas.

## Fila, evidências e fechamento

Persistência: `.local/friction/operations/`, `.local/friction/states/` e `.local/friction/reports/` da raiz operacional.
`ssam_evidence` lê essas pastas (são raiz do registro `evidence-roots.mjs`).
A fila é uma projeção desses registros persistentes; toda falha observada já participa dela,
sem job de ingestão, prompt ou anotação. A deduplicação usa perfil, operação, faixa, código e
etapa. O código conhecido `SNAPSHOT_AUTHOR_MISSING` identifica a recusa real do CSS. Outros
erros ainda podem compartilhar `OPERATION_FAILED`: são agrupamentos de triagem, não uma
afirmação de que todas as causas sejam iguais. Versões e ocorrências individuais ficam visíveis.

Uma chamada sem término aparece como incompleta, não como aprovada nem automaticamente como
falha. Pode ser uma execução ativa ou uma interrupção abrupta; é necessário reconciliar o
recibo original antes de repetir qualquer escrita. Cancelamento/queda observados são incertos.
Um recibo que declara `outcome: uncertain` conserva essa classificação; `gate: equivalence`
produz `EQUIVALENCE_UNCERTAIN`. A fila nunca recomenda repetir merge incerto.
Um limiar explícito `SSAM_FRICTION_SLOW_MS` pode gerar `SLOW_OPERATION` em sucessos; isso é
um sinal, não um defeito nem uma mudança dos gates atuais de performance.

```powershell
.\ssam friction state --issue <id> --status investigating
.\ssam friction state --issue <id> --status corrected --revision <revisao-atual> --proof <prova.json>
.\ssam friction state --issue <id> --status verified --revision <revisao-atual> --proof <prova-final.json>
```

O arquivo de prova tem `schema: "ssam-friction-proof/1"`, `checksPassed: true`,
`versionSha256` e, para verificação, `operationId`. O hash do arquivo é preservado.
A correção não fecha a ocorrência. A verificação exige também uma operação posterior bem
sucedida da mesma operação/faixa/perfil na versão corrigida. O autor da prova é responsável
por que ela seja uma reprodução legítima: o observador não deduz equivalência semântica do
caso só pelo retorno `ok`. O hash operacional não certifica DLLs; quando o reparo depender
delas, a prova deve incluir a qualificação nativa antes de marcar como verificado.
Recorrência posterior reabre a ocorrência. Revisões obsoletas são recusadas; transições
simultâneas que formem uma bifurcação ficam em conflito explícito, sem escolher um vencedor.

Recibos existentes podem ser importados explicitamente, sem executar novamente a entrega:

```powershell
.\ssam friction ingest --receipt <deliver-result.json> --lane odc --task-id <id>
.\ssam friction ingest --receipt <last-error.json> --operation merge --lane odc --task-id <id>
```

A operação só assume `deliver` para `deliver-result.json` com estrutura de entrega reconhecível.
Recibos genéricos exigem `--operation` explícita e válida; a importação não inventa a operação.
A importação usa hash do conteúdo, é deduplicada e registra a duração declarada no recibo
separada da duração de importação. Não inventa versão nem cronologia anteriores.
A fixture sanitizada do CSS conserva 25,275 s da entrega. Os aproximadamente cinco minutos
da tarefa inteira não podem ser reconstruídos a partir daquele recibo sozinho.

Não são persistidos argumentos, senha, texto de erro, CSS, modelo, host ou corpos de resposta.
A única exceção são os campos curtos que a sessão escreve de propósito num `report`.
Recibos são referenciados por SHA256 e hash do localizador; o caminho legível continua no
recibo/journal operacional original. Esta versão não cria um índice global desses caminhos.
Os arquivos locais ficam sujeitos às permissões da pasta do próprio usuário; não há serviço
de envio, centralização remota ou troca de ACL de diretórios existentes.

## Falhas do próprio registro e limites operacionais

Escritas usam arquivos temporários completos com flush e publicação atômica no mesmo volume.
Os eventos são imutáveis e têm nomes únicos; processos concorrentes não compartilham append.
Temporários interrompidos e JSON danificados são apresentados em `health`. Uma falha de
registro avisa por stderr e não muda o resultado da operação. Se não houver permissão nem
espaço para gravar, não se pode garantir que esse aviso sobreviva fora do stderr do cliente.

Respostas CLI/MCP são observadas em memória com limite de 4 MiB, sem persistir os corpos.
Quando o limite impede classificar o resultado, há aviso e resultado desconhecido/incompleto,
nunca sucesso inventado. O protocolo original continua sendo encaminhado. A fila mostra as
últimas cinco operações por agrupamento; consultas de tarefas e ocorrências têm paginação.
Escrever é custo constante por operação. Consultar percorre metadados; retenção/indexação
incremental e recuperação automática de conflitos ficam para uma evolução, sem apagar
evidências por conta própria nesta entrega.

**Fila atualizada automaticamente não é notificação entregue.** O campo `notificationDelivery`
explicita que falta um consumidor. Esta mudança não cria automação Codex, email ou WhatsApp,
nem envia instruções ao integrador. Um consumidor futuro pode consultar a fila sem depender
de boa vontade da sessão de aplicação. Sessões MCP antigas não recebem o observador até uma
nova conexão com o launcher atualizado.

## Ativação sem interromper o ODC em uso

1. Revisar o commit funcional isolado; o commit de baseline contém cópias das fontes sujas
   operacionais e **não** deve ser aplicado por cima da raiz ativa. Inventário em
   `FRICTION-BASELINE-INVENTORY.json`.
2. Integrador incorpora somente os arquivos novos e o diff localizado de `facade/launch.mjs`,
   conciliando qualquer alteração concorrente. Não tocar releases imutáveis, ponteiros,
   seleção, DLLs carregadas, projetos abertos ou configurações MCP.
3. Rodar `node --test tests/friction.test.mjs tests/workspace.test.mjs` no checkout preparado.
   A suíte usa processos simulados e diretórios temporários; nenhum Studio ou tenant.
4. Após revisão, novas invocações CLI passam a registrar. Abrir uma conexão MCP nova e provar
   `tools/list`, operação de leitura e `ssam_friction`; manter conexões antigas até concluírem
   seus trabalhos. Não migrar nem reiniciar silenciosamente uma sessão ativa.
5. Conferir metadados/versionamento e orçamento de latência com prova leve nessa nova conexão.
   Ter código preparado não equivale a instalado ou a qualificação de performance ODC.

Validação preparada: falha real sanitizada, processos CLI/MCP distintos, repetição deduplicada,
consulta em outra sessão, concorrência, privacidade, timeout/cancelamento, início sem fim,
registros parciais, falha de persistência e transições que recusam fechamento sem prova/versão.
