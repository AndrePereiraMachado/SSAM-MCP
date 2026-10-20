# Ciclo de vida da carga por arquivo

Contrato da quarta correção CX13, definido antes da implementação. Decisão do
dono de 15/10/2026: arquivo exige `keys`, únicas e não nulas no conjunto de
arquivos. Insert e update por arquivo fazem upsert por essa chave: iguais não
escrevem, diferentes atualizam o identificador observado, ausentes inserem.
`records` inline conserva a semântica nativa de insert/update.

Decisão do dono de 17/10/2026 (revisão 5, U1, extensão da regra destrutiva da
CX15): nenhuma escrita por arquivo sobrescreve linha existente sem prévia e
confirmação. Toda sobrescrita (insert que encontra a key, update, rechecagem e
reconciliação que encontram outro valor, inclusive de outro escritor) para a
chamada ANTES de escrever com `updatePreview` (linha, identificador, atual -> novo,
contagens). Só `confirmUpdates:{previewSha256,authorize}` com as palavras do dono
posteriores à prévia, nunca vistas antes e com o número exato de linhas cobre
essas transições exatas; valor mudado depois da prévia gera prévia nova. Linhas
novas seguem sem palavras. Todo recibo (completo, parcial, falho, cancelado, incerto e
closed) guarda `updatedRows` com o valor anterior; sobrescritas enviadas sem resposta
ficam em `uncertainUpdatedRows`, também com o valor anterior (revisão 6, R6-U1b).
`insertMissing:false` num update recusa chave ausente (DATA_KEY_NOT_FOUND).

Sem keys, uma recusa `DATA_LOAD_KEYS_REQUIRED` agrega os problemas antes de
qualquer escrita. Traz candidatos únicos e não nulos observados nos arquivos e
índices únicos declarados no esquema. Só um índice único do modelo vira
continuation, e sempre como dryRun (insere / atualiza atual -> novo / mantém por
linha); coluna única só no arquivo é lista para o dono, nunca escolhida. Não
inventa uma chave para linhas idênticas.

| Estado | Evento / ação do cliente | Transição e próximo passo |
|---|---|---|
| Sem plano | Preflight inválido, keys ausentes ou repetidas | Recusar tudo; corrigir antes de escrever; sem reserva persistente |
| Sem plano | Plano com sobrescrita de linha existente | DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED antes de qualquer escrita; `updatePreview`; sem plano nem reserva; `confirmUpdates` com palavras do dono e contagem |
| Resumable | Rechecagem ou reconciliação encontra outro valor | Mesma parada antes de escrever, com todas as linhas abertas que mudariam |
| Reserva sem plano | Processo dono morto (inline ou carga antes do plan.json) | Reserva removida pela próxima chamada; dono vivo: BUSY com `ownerHasPlan:false` e repetir a mesma chamada |
| Resumable / ready | Lote confirmado | Registrar IDs/linhas; próximo lote, ou completed |
| Pending | Falha parcial correlacionada | Confirmar sucessos; failed para linhas rejeitadas; oferecer prévia de encerramento |
| Pending | Prova de não envio | Not-submitted; retomar com argumentos originais e reler keys |
| Pending | Processo morto, timeout, cancelamento dentro da escrita ou erro nativo sem recibo | Persistir uncertain; retomar por leitura das keys, nunca reenviar às cegas |
| Pending O11 recuperável | Resposta perdida | Reler as keys do lote; nenhuma repetição cega, mesmo com recibo marcado recuperável |
| Uncertain | Keys presentes e iguais | Reconciliar IDs; limpar erro nativo transitório; seguir restantes |
| Uncertain | Keys ausentes ou diferentes | Replanejar insert/update a partir da leitura atual; sem duplicar |
| Uncertain | Keys ambíguas ou relatório contraditório | Preservar incerteza; oferecer prévia de encerramento |
| Resumable | Prazo real entre lotes | Preservar plano/reserva; retomar com chamada original |
| Resumable | Arquivo editado / ID_REUSED, falha determinística, cancelamento ou desistência | Oferecer prévia de encerramento na mesma ferramenta/operationId |
| Resumable | Leitura/tenant indisponível | Corrigir causa e retomar com argumentos originais; encerramento explícito disponível |
| Resumable | Retomada sem palavras | Usa as palavras do plano (load-authorization-from-plan; o plano guarda só o sha256) |
| Uncertain com keys | Resposta incerta | `outcome:"reconcilable"`: a mesma chamada reconcilia relendo as keys |
| Resumable | `close:{preview:true}` | Sem escrita de dados; prévia por arquivo/linha: confirmadas, failed, uncertain, notSent e unchanged; sha256 do snapshot |
| Resumable | `close:{previewSha256,authorize}` | Exigir prévia atual (30 min) e palavras do dono pela regra da CX15 (abaixo), com o número de linhas que ficam sem escrita; preservar diário/recibo, gravar closed, liberar reserva |
| Resumable | Snapshot mudou após prévia | Recusar confirmação; gerar nova prévia antes de confirmar |
| Completed | Repetir | Recibo, zero escrita, done |
| Closed | Repetir / retomar com qualquer argumento | DATA_LOAD_CLOSED com recibo e linhas; zero escrita; nova carga com keys e novo operationId |
| Resumable | Nova carga, insert ou update inline no mesmo alvo | DATA_ENTITY_LOAD_BUSY; seguir a dona |

Não existe mais fechamento automático por “incerto sem keys”: esse caminho e
os estados específicos de arquivo sem keys saíram. Todo fechamento é explícito,
com prévia e confirmação; a resposta de uma carga antiga sem keys exige migrar
por encerramento, preservando suas evidências. Fechar não desfaz dados nem afirma
que linhas incertas não foram gravadas. Elas continuam nomeadas como incertas.

`next` e `continuation` descrevem a mesma ação. Quando indicam encerramento,
apontam primeiro para a prévia, nunca para confirmação presumida. O fechamento
usa o plano e o diário salvos, mesmo se o arquivo sumiu ou o tenant está offline.
Uma prévia não libera a reserva. PID morto libera somente a trava de execução.

A reserva canônica tem escopo por `journalRoot`: ODC usa tenant normalizado,
moduleKey do produtor e entityKey resolvidos pelo canal; O11 usa host normalizado
(minúsculas, sem porta padrão ou barra final), módulo e entidade resolvidos.
Grafias alternativas e `records` inline passam pela mesma exclusão. Escritores
externos e instalações com outro journalRoot exigem unicidade no banco.

O diário conserva os erros nativos em histórico e as linhas confirmadas por ID.
Recibo/fechamento separam successfulRows, failedRows, uncertainRows, notSentRows
e unchangedRows. Contagens confirmadas nunca incluem linhas apenas não enviadas.
Um recibo incerto é resolvido por leitura das keys do lote. O texto “N of M
records failed” prova envio, mesmo sem evidence legível. As propriedades usam
banco falso real, seed fixa, milhares de sequências, falhas tardias/determinísticas,
processo morto, prazo, cancelamento, aliases, arquivo editado e escritor externo;
todo percurso termina completed ou closed e permite carga corrigida nova.

Identificador da fonte serve para correlação; quando não faz parte de keys, a
comparação de igualdade usa os atributos de negócio e o identificador observado
no servidor. Isso evita atualizar repetidamente uma linha só porque o servidor
atribuiu outro ID. Os canais exportam índices únicos do modelo como metadados,
incluindo índices compostos e entidades referenciadas no ODC. Kernel antigo que
não retorna moduleKey/entity.key é recusado antes de escrita: compile a versão
atual; não há fallback para o nome digitado.

O identificador auto-number da entidade (atribuído pelo servidor) não pode
participar de keys nem ser sugerido como chave natural (DATA_LOAD_KEY_NOT_NATURAL),
inclusive em chaves compostas (revisão 5, I1: só auto-number). O O11 usa o
autoNumber do schema; a bridge ODC informa identifierAutoNumber e, sem ele, um
identificador não inteiro conta como não gerado. Um identificador natural é a
chave única da entidade: vale como key e é o primeiro candidato do modelo. IDs client-* de InsertRecords são correlação, não valores
persistidos da key; aceitá-los permitiria duplicar após uma resposta perdida.
A bridge ODC retorna identifier inclusive com entidade vazia. Se a versão antiga
não o informa e não há linha para observá-lo, a operação recusa antes de escrever.
Na linha hospedada (a bridge `v97`, a de todo pacote em uso, que não informa identifier nem
identifierAutoNumber), essa recusa é uma só e diz o caminho que existe hoje (seguimento a9, M1):
`DATA_READ_UNAVAILABLE` no ponteiro `/identity`, com a continuação `studio_data_insert {module, entity,
records:[a primeira linha do arquivo], authorize}` (as palavras do usuário) e, em `nextCalls`, a mesma carga
sem as palavras: as chaves dela acham essa linha inalterada e inserem as outras. Nada é escrito pela
recusa. A recusa de chave de um identificador inteiro não oferece mais "reconnect through a bridge".

Rodada 2 do seguimento a9 (revisão `a9-followups-line`, B): a prévia que `DATA_LOAD_KEYS_REQUIRED` oferece (o índice
único do modelo, `dryRun`) e o `correctedRequest` não levam as palavras do dono: uma prévia não precisa delas, e o
`correctedRequest` é um eco que a regra das palavras da saída do hub não mascara.

Rodada 2 (C): um `studio_data_update` com `insertMissing:false` numa entidade vazia não propõe inserir a primeira linha.
Cada chave dá `DATA_KEY_NOT_FOUND` (como numa entidade com linhas), nada é escrito, e o `next` diz que inserir é a única
saída e manda perguntar ao dono; não há continuação. Sem `insertMissing` (o upsert), a recusa do M1 fica como era.

Rodada 2 (D): numa carga de escrita, o `nextCalls` leva o marcador `authorize: "<the user's own words>"` e `askOwner`,
como a continuação: a carga repetida pede as palavras do dono de novo (o servidor nunca as repete); repetido como veio
dá `WORDS_REQUIRED` e nada é escrito. No `dryRun` o `nextCalls` é outra prévia, sem palavras. A continuação de escrita
de uma prévia com linhas novas também leva o marcador e `askOwner` (antes vinha sem as palavras e dava uma 2ª recusa
`INPUT_INVALID /authorization` sem passo), e essa recusa agora traz o `fix` (pedir as palavras ao dono). Sem nenhuma
linha que possa entrar como está, a recusa não cita passo que não traz (G).

## Palavras do dono: a regra única da CX15 (revisão 6)

Regra do dono (CX15 r5..r7): um predicado só para as palavras do dono, em todo portão. A carga
por arquivo não tem cópia própria (`data-load-words.mjs` saiu); usa `destructive-operations.mjs`:

- Portão: um campo de palavras da chamada (`authorization`/`authorize`, `confirmUpdates.authorize`,
  `close.authorize`, `ownerRequest`) presente que não é palavra do dono (`wordsGiven`: `<...>`,
  `<the user's own words>`, `<palavras do usuário>`, OWNER_REPLY, `sha256:<hex>`) dá UM
  `WORDS_REQUIRED` com todos esses campos, antes de trava, leitura ou escrita (`callWordsProblems`,
  o mesmo do hub). Palavras ausentes seguem a regra própria da carga (plano, prévia da mesma carga).
- Prévias de sobrescrita (`updatePreview`) e de fechamento (`closePreview`) são prévias da CX15
  (`createPreview`/`checkExecute`): ligadas à ferramenta, ao host e a uma operação que nomeia o
  `operationId` e o fingerprint da carga; valem `PREVIEW_TTL_MS` (30 min); a prévia de sobrescrita é
  consumida quando concede (`consumedAt`) e nunca concede de novo; prévia de outra carga, vencida,
  consumida ou desconhecida dá prévia nova e zero envio (`DATA_LOAD_UPDATE_PREVIEW_CHANGED`,
  `DATA_LOAD_CLOSE_PREVIEW_CHANGED`). Um dryRun sem `operationId` liga a prévia ao `operationId`
  que a sua continuation leva.
- "Visto antes": o armazém da CX15 por host (`seen-words`, 24 h, comum a toda ferramenta
  destrutiva), as palavras desta chamada, o `ownerRequest` e as palavras que o plano da carga já
  conhece (as dela e as das confirmações anteriores, sem limite de 24 h). Palavras que já
  confirmaram uma prévia ficam vistas no host: não confirmam uma prévia feita DEPOIS delas (por 24 h
  no host; sempre, dentro da mesma carga), e uma chamada que as reenvia as anota de novo antes da
  prévia nova. Mas uma prévia que já existia quando elas foram usadas ainda as aceita: a prévia
  congela o que foi visto quando nasceu, e `checkExecute` só confere esse retrato e o `usedWords` do
  próprio registro (regra da CX15, igual em todo portão; revisão 7, R7-4, P6). Fechar isso é
  mudança da CX15 para todos os portões (um registro por host das palavras que já confirmaram),
  decisão do dono; a carga não tem regra própria.
- Também da CX15: idade mínima de 5 s, recusa de texto do servidor (inteiro ou cinco palavras
  seguidas), número exato de linhas como numeral; uma recusa lista todos os problemas.
- A authorization tirada de uma prévia só vale para a mesma carga (`operationId` e fingerprint;
  revisão 6, B-P4).
- Opções da carga (listadas com o esquema mais barato; `close`, `columns` e `references` com o esquema
  vazio desde a revisão 8, R8-1: as formas de `close` estão no texto da ferramenta e a carga recusa
  `columns`/`references` que não sejam objeto): a carga as valida numa recusa só, antes de
  qualquer escrita. `delimiter`, `files`, `keys`, `columns` e `references` malformados são recusados
  depois de ler o esquema e as linhas (custo de leitura, nunca escrita; revisão 7, R7-7); chave
  desconhecida dentro de uma entrada de `references` é ignorada.
- Só o sha256 das palavras normalizadas é gravado ou enviado: `plan.json` (`authorizationSha256`),
  `journal.jsonl`, `.update-previews`, `close-preview.json`, recibos e continuations guardadas não
  têm palavras; o kernel O11 (`--request`) e a bridge ODC (`--authorize`) recebem `sha256:<hex>`.
  Plano ou diário de versão anterior com palavras em claro é regravado com o sha256 na leitura.

Diferenças que ficam em relação ao delete de dados da CX15:
- Nome da entidade nas palavras (`WORDS_MUST_NAME`): decisão do dono pendente. A carga não exige;
  o ponto de ligar é um só, `WORDS_NAME_THE_ENTITY` em `data-load.mjs` (pede o nome na prévia e
  roda a regra `entityRule` do delete).
- Uso único: o delete marca o uso no registro de operação da CX15; a carga marca a prévia consumida
  (`consumedAt`) e guarda a concessão no plano, sem registro de operação da CX15.

## Cerca com a CX12 (para a integradora; revisão 5, F12)

Uma carga por arquivo com keys é idempotente por `operationId` + keys: a resposta
de um lote incerto se resolve retomando a MESMA chamada, que relê as keys antes de
qualquer escrita e nunca reenvia às cegas. Por isso essa resposta declara
`outcome:"reconcilable"`, `reconcilable:true` e `reconcileBy:["operationId","keys"]`
(com `code:"DATA_OUTCOME_UNKNOWN"` e `uncertainRows`), nunca `outcome:"uncertain"`.
Só uma contradição nativa (`manualReconciliationRequired`) ou uma key ambígua,
que o dono precisa resolver, continuam `outcome:"uncertain"`. A retomada de um
plano validado usa as palavras gravadas no plano; uma continuation sem
`authorize`/`authorization` retoma normalmente.

O que a CX12 precisa reconhecer ao integrar (sem mudar a CX12 nesta entrega):
- `stateOf`/`completionState`: `outcome:"reconcilable"` (ou `reconcilable:true`) não
  é estado incerto; a guarda `TASK_UNCERTAIN_PENDING` não deve segurar a repetição
  da mesma chamada, que é a reconciliação. Com 2563cdbd e d753c026 como estão, isso
  já vale (o estado vira `failed`), e verify-3\f12.mjs conclui sem laço nas duas.
- `isMutation` (tool-classification.mjs): `dryRun:true` e `close:{preview:true}` (ou
  `close` sem `previewSha256`) de `studio_data_insert`, `studio_data_update` e de
  `o11_data` (dentro de `request`) não escrevem dado, como em `studio-write-lock.mjs`.
  `close:{previewSha256,authorize}` e `confirmUpdates` são escritas.
- Se a CX12 retirar palavras do dono das continuations (d753c026), a carga continua
  retomável; a confirmação de fechamento ou de sobrescrita pede palavras novas do
  dono de qualquer forma.

A mesma recusa e aplicada antes de retomar qualquer plano ja validado de uma
versao antiga que usou o identificador como key. A carga permanece reservada,
com continuation para previa de encerramento; so depois da confirmacao uma
carga nova com chave de negocio pode adotar as linhas existentes sem duplicar.
