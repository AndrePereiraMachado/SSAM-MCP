# Dados O11 pelo cliente nativo do Service Studio

`ssam data --lane o11` e MCP `o11_data` leem e alteram registros publicados com
`EditDataAPIRestClient`, a mesma API interna usada por Edit Data no Studio.
Nao precisam de GUI, SQL, actions ou timers no aplicativo. A interface publica
do SSAM e nossa; o cliente da OutSystems e interno, nao uma API publica suportada.

## Uso

Use o host ja conectado ao modulo alvo e um snapshot publicado desse modulo:

```powershell
.\ssam data --lane o11 --host <host-conectado> --module Astra1_CS `
  --oml <snapshot-publicado.oml> --request <pedido.json> --out <resultado.json>
```

Leitura, por nomes pertencentes ao modulo:

```json
{"operation":"read","entity":"Horse","offset":0}
```

Uma pagina nativa por chamada. `count` e `nextOffset` permitem avancar ate uma
pagina vazia. `ids`, `tenantId` e `includeBinary` sao opcionais.

### Leitura limitada (P3, 08/10/2026)

Um `read-all` de AuditEntry a partir do offset 100000 levou 330 s contra o Studio,
e o Studio congelou e fechou (atrito cc5deb6b; leituras de 220 a 320 s na sessao
534731c6). O `read-all` antigo percorria ate 1000 paginas numa chamada, sem prazo e
com tudo em memoria. Regra agora (`EnvironmentData.ReadPaged`):

- cada pagina tem tempo maximo dos dois lados: o Studio desiste do `GetRecords`
  em 30 s e solta a fila do bridge; a CLI tambem para de esperar em 30 s;
- `read-all` devolve no maximo `limit` linhas por chamada (padrao 2000, teto
  10000; pode passar uma pagina) e para em `deadlineMs` (padrao 60000, de 1000 a
  120000), contados do inicio da chamada inteira;
- resposta incompleta: `complete:false`, `stoppedBy` (`limit`, `deadline` ou
  `page-timeout`) e `continuation:{offset}`; o MCP devolve a chamada pronta em
  `continuation` (mesma leitura, proximo offset);
- primeira pagina que estoura o tempo: `ok:false`, `code:"DATA_READ_TIMEOUT"`,
  com o mesmo offset para tentar de novo.

O Edit Data so pagina por offset (sem filtro nem keyset): offset profundo continua
custando ao servidor, mas nunca mais que uma pagina limitada por vez. Para poucos
registros conhecidos, leia por `ids`. A leitura ja rodava fora da thread de UI
(`Task.Run` no bridge); a validacao da sessao na thread de UI e do bridge.

A leitura devolve cada valor no formato que a escrita aceita de volta, pelo tipo
do atributo (uma linha lida pode ser regravada sem mudanca):

| Tipo | Leitura | Escrita aceita | Texto gravado |
|---|---|---|---|
| Date Time | `"2026-10-03T23:55:00"` | `yyyy-MM-ddTHH:mm:ss[.fff]`, `yyyy-MM-dd HH:mm:ss` ou `yyyy-MM-dd` | `2026-10-03 23:55:00` |
| Date | `"2026-09-28"` | `yyyy-MM-dd` | `2026-09-28` |
| Time | `"13:45:00"` | `HH:mm:ss` ou `HH:mm` | `13:45:00` |
| Boolean | `true` / `false` (JSON) | JSON bool ou `"True"`/`"False"` | `True` / `False` |
| Integer | numero JSON | numero ou digitos, ate 2147483647 | numero invariante |
| Decimal, Currency | numero JSON | numero ou texto com `.` decimal | numero invariante |
| Long Integer, Id e FK | string | string, ou inteiro JSON ate 2^53 | digitos |
| Text, Email, Phone | string | qualquer string | o texto |

Data com `Z` ou com offset (`-03:00`) e recusada: o Edit Data grava a hora local
de parede e a ferramenta nunca adivinha conversao. Valor que o tipo nao le e
recusado ANTES de qualquer escrita, com `code:"DATA_VALUE_INVALID"` e o texto
`<Entidade>.<Atributo> (<Tipo>): '<valor>' ...; accepted: ...`. Motivo: o Edit
Data grava texto ilegivel como o valor nulo do tipo e ainda responde Success
(em 04/10, sessao 890a2354, datas `2026-10-04T15:38:07` viraram 1900-01-01 em 12
jogos e 4 transacoes). Formato medido no tenant: `2026-10-03 23:55:00` e
`2026-09-28` voltam na leitura como `2026-10-03T23:55:00` e `2026-09-28T00:00:00`.

Escrita:

```json
{
  "operation":"insert",
  "entity":"HorseQuirk",
  "operationId":"ad168c87-32bc-4a21-83e1-38a926ae42e9",
  "authorization":"<palavras reais do usuario autorizando esta carga>",
  "records":[{"HorseId":"<ID retornado pelo servidor>","Label":"Loves carrots","SortOrder":1}]
}
```

`update` usa `records` com `Id`; `delete` usa `ids`. `binary` usa `recordId`,
`attribute` e `base64`, chamando `InsertBinaryToRecord`. Campos AutoNumber nao
podem ser enviados em insert. Entidades estaticas sao legiveis, mas sua escrita
continua pelo modelo/publicacao. Campos desconhecidos e tipos JSON compostos
sao rejeitados antes de enviar. FKs usam IDs reais lidos/retornados pelo servidor;
as restricoes e permissoes permanecem sob controle do servidor.

O CLI le `SSAM/O11/<host>/ServiceStudio` do Credential Manager privado, sem
imprimir senha nem gravar credenciais no repositorio. `--credentials` ainda
aceita o arquivo privado legado; seu host deve coincidir com `--host`.
`--read-only` recusa toda escrita. O CLI confirma a identidade do modulo na
listagem viva antes de chamar Edit Data e exige a capacidade `EditDataV4`.

Sem `--host` e sem `--credentials` (ou com `--studio`), o mesmo verbo `data` usa o
Service Studio ja logado na faixa, inclusive com SSO obrigatorio: as operacoes
`data-read`/`data-write` da bridge chamam o Edit Data do proprio Studio, sem
credencial (`--credentials` e recusado nesse modo; com `--studio`, `--host` so
confere o ambiente). Aceita tambem `read-all` e um lote
`{"authorization": "...", "batch": [...]}`, sem `binary`; (System) e Users sao
recusados. Contrato em `kernel/src/Anvil.Cli/DataCommand.cs` e
`EnvironmentData.cs`; os recibos sao os mesmos (`DataReceipt`). O MCP `o11_data`
usa sempre este modo (`--studio`, com `--host` so conferindo o ambiente).

## Lote, `$ref`, update minimo e releitura (modo Studio)

O pedido inteiro e conferido antes de abrir a sessao: nomes de entidade e de
atributo, `authorization` e `operationId` de cada escrita, cada valor pelo tipo e
cada `$ref`. Havendo problema, nada e enviado e a resposta traz TODOS de uma vez:
`{ok:false, code, problems:[{op, pointer, code, message}], submitted:0}`.

- **`$ref`.** Um valor de atributo ou um id pode ser `{"$ref":"<step>"}` (insert
  de exatamente 1 registro) ou `{"$ref":"<step>#<i>"}` (i-esimo, base 0): o id
  que um insert anterior do mesmo lote devolveu. Referencia futura ou desconhecida
  recusa o lote antes da primeira escrita, com `DATA_REF_UNRESOLVED`.
  ```json
  {"authorization":"<palavras do usuario>","batch":[
    {"operation":"insert","entity":"Game","step":"jogos","operationId":"<uuid>","records":[{"Title":"A"},{"Title":"B"}]},
    {"operation":"insert","entity":"Review","operationId":"<uuid>","records":[{"GameId":{"$ref":"jogos#1"},"Body":"ok"}]}]}
  ```
- **Insert** responde `ids` na ordem dos registros (pelo id de cliente
  `new-<i>`, nao pela ordem dos relatorios do servidor).
- **Update** le antes os registros pelo id e envia so as celulas cujo valor
  canonico muda; registro sem mudanca nao e enviado. Tudo igual: `ok:true`,
  `unchanged:n`, `written:0`, nenhuma escrita. Ecoar uma linha lida com uma
  mudanca de texto nao toca mais nas datas.
- **Releitura.** Depois de todo insert e update, os ids gravados sao relidos e
  comparados pelo valor canonico. Diferenca: `ok:false`,
  `code:"DATA_READBACK_MISMATCH"`, `differences:[{id, attribute, sent, stored}]`.
  Releitura que falha: `code:"DATA_READBACK_FAILED"`, `outcome:"uncertain"`. Nos
  dois casos a escrita fica no recibo e nunca e repetida.

A credencial privada (`--host`) usa a mesma normalizacao por tipo na escrita e na
leitura (`EntityData.cs`); `$ref`, update minimo e releitura sao do modo Studio.

## Recibos e retomada

O diretorio padrao e `kernel/.local/data/receipts` (SS4); MCP SS5 usa
`kernel/.local/lane-ss5/data/receipts`. CLI permite `--work`; mantenha o mesmo
diretorio na retomada. A autorizacao, alvo e hash de pedido/modelo ficam no
recibo antes da chamada. A operacao tem um lock exclusivo e um UUID estavel.

- Mesmo UUID/pedido concluido: retorna o recibo, sem reenviar, inclusive falhas parciais.
- Mesmo UUID com outro pedido/alvo: recusa.
- Timeout, queda ou resposta impossivel de interpretar: fica `pending` e recusa repeticao.
- Reconciliar recibo e leitura viva antes de decidir um pedido novo. Nao apagar evidencias.

O servidor responde por registro; um lote nao e uma transacao atomica. `ok`
so e verdadeiro quando a quantidade de respostas coincide e todas sao Success.
Para seed repetivel, consulte uma chave natural unica (por exemplo SeedCode),
insira apenas ausentes e use os IDs retornados nas tabelas filhas. Recibos evitam
repetir a operacao; nao substituem a unicidade do banco entre pedidos distintos.

## Carga a partir de arquivo

Use uma chamada de `o11_data` com `request.operation:"insert"` ou `"update"`,
`entity` e `files:[caminhos absolutos]`, no lugar de `records`. Os formatos sao
JSON (array ou envelope com `records`), JSONL/NDJSON e CSV UTF-8 com cabecalho.
Limites: 1000 arquivos, 64 MiB por arquivo, 256 MiB no total. O separador CSV
padrao e virgula; declare `delimiter` para outro, sem deteccao automatica.

`columns` mapeia nomes exatos ou ignora uma coluna com null. Celula CSV vazia
e atributo ausente: insert usa o default do banco, update nao toca na celula.
Null explicito so em JSON/JSONL. `references` resolve uma FK pela chave natural
do pai, somente em entidades do proprio modulo no O11. `keys` declara a chave
natural obrigatoria do alvo, em toda carga por arquivo, inclusive dryRun.
Insert e update fazem upsert: chave igual com valores iguais nao escreve;
chave ausente insere. Valores diferentes numa chave existente sobrescrevem uma
linha: por decisao do dono de 17/10/2026 (CX13 U1, extensao da regra destrutiva
da CX15) a chamada para ANTES de qualquer escrita com `updatePreview` (linha,
identificador, valor atual -> novo, contagens) e so escreve com
`confirmUpdates:{previewSha256,authorize}`, cujas palavras sao a proxima mensagem
do dono depois da previa, pela regra unica da CX15 (revisao 6): nunca vistas antes
no host (nem as da carga, nem as de outra ferramenta destrutiva, nem o `ownerRequest`),
com o numero exato de linhas, pelo menos 5 s depois da previa, dentro de 30 min; a
previa e da carga que a fez (operationId e fingerprint) e concede uma vez so. Texto do
servidor (marcador, `<...>`, `sha256:<hex>`) como palavras e WORDS_REQUIRED antes de
qualquer leitura. O kernel recebe `sha256:<hex>` das palavras; plano, diario e previas
guardam so o sha256. Vale para insert que encontra a
chave, update, rechecagem e reconciliacao que encontram outro valor (inclusive de
outro escritor). Linhas novas nao pedem palavras. Todo recibo (completo, parcial,
incerto, closed) guarda `updatedRows` com o valor anterior e o novo. `insertMissing:false` num update recusa a chave
ausente com DATA_KEY_NOT_FOUND (nunca insere um erro de digitacao); sem ele o
update continua upsert. O identificador auto-number (gerado pelo servidor) nao
pode fazer parte de keys nem dos candidatos: DATA_LOAD_KEY_NOT_NATURAL evita
confundir ID de correlacao com chave persistida. O O11 usa o autoNumber do schema;
um identificador que nao e auto-number (Integer sem auto-number, Text Code) e a
chave unica da propria entidade: vale como key e e o primeiro candidato da
continuation dryRun. No ODC a bridge informa identifierAutoNumber; sem ele, um
identificador nao inteiro conta como nao gerado e um inteiro continua recusado
com a saida possivel (outras keys de negocio, ou bridge que informe o dado). Texto e comparado exatamente, incluindo maiusculas.

A carga valida todos os arquivos e todas as operacoes antes do primeiro lote.
Uma recusa agrega arquivo, linha e coluna; `problemsFile` guarda todos os detalhes.
Cada grupo tem um pointer por arquivo e coluna; linhas usam a numeracao fisica
do arquivo, inclusive no CSV com cabecalho ou celulas de varias linhas.
Arquivos repetidos por caminho ou SHA-256, keys nulas/ausentes/repetidas e linhas
sem atributos a escrever sao recusados antes de qualquer lote. Sem keys a recusa
DATA_LOAD_KEYS_REQUIRED agrega candidatos unicos e nao nulos do arquivo e indices
unicos do esquema. So um indice unico do modelo vira continuation, e sempre como
dryRun; uma coluna unica so no arquivo nunca e escolhida: e lista para o dono.
Linhas identicas sem chave natural exigem corrigir a fonte, nunca inventar IDs.
No update, o identificador sozinho nao conta como atributo a escrever.
`dryRun:true` retorna as contagens sem autorizacao, operationId ou escrita, e por
linha insere / atualiza (atual -> novo) / mantem em `rowsPreviewFile`; havendo
sobrescritas, traz a `updatePreview` que as palavras do dono podem confirmar.
Cada dryRun refaz o plano e as leituras; nunca reutiliza contagens de outro ensaio.
Na escrita, forneca as palavras da pessoa e um `operationId` UUID estavel.
`batchSize`: 1..1000, default 100. `deadlineMs`: 1000..120000, default 60000.

Plano, diario e recibo ficam em `<work>/loads/<operationId>/`. Mesmo id com arquivo
ou opcoes diferentes recusa; lotes concluidos nao sao reenviados. Se o prazo
terminar, use a mesma chamada da continuation. Uma resposta perdida e resolvida relendo as keys do lote, inclusive no O11
quando o recibo nativo e recuperavel; nunca reenvia o lote as cegas. As palavras ficam fixadas no plano e sao usadas byte a byte em cada
lote; as palavras de cada retomada ficam no diario. O SHA-256 do OML tambem faz
parte da identidade da carga O11.

Um erro que prova nenhum envio permite retomar o mesmo id de lote. Um relatorio
completo de falha parcial guarda os IDs escritos e os motivos por linha: a
retomada envia somente as linhas que falharam, com outro id de lote. Um recibo
completed do kernel conserva seus IDs, inclusive se a releitura acusou diferenca.
Perda de transporte ou resultado explicitamente incerto exige reconciliacao;
releia as keys do lote antes de escrever o que falta ou mudou. Nao ha caminho
de escrita por arquivo sem keys.
As respostas parciais contam somente linhas com conclusao registrada, incluem
written e colocam as faixas de linhas incertas em uncertainRows.

A carga tem uma trava exclusiva com PID; somente um PID encerrado permite
recuperar uma trava velha. A reserva canonica tem escopo por journalRoot: O11
normaliza host (minusculas, sem porta padrao/barra final) e usa modulo/entidade
resolvidos; ODC usa tenant e moduleKey/entityKey do produtor, incluindo referencias.
Insert/update inline conservam semantica nativa e passam pela mesma reserva.
Outra carga aberta no mesmo alvo canonico e
recusada com o id da dona. A retomada relê as chaves ainda nao enviadas; cancelar
para entre lotes, conservando a trava de escrita ate o lote em voo terminar.
O recibo lista SHA-256,
contagens e regras aplicadas; listas grandes ficam no arquivo do recibo.

O ODC oferece as mesmas opcoes em `studio_data_insert` e `studio_data_update`,
com `authorize`. Seus recibos declaram `readback:"not available"`; lote pendente
so e reconciliado por chaves, nunca reenviado as cegas.
O ODC converte Text vazio em null: a regra odc-empty-text-null informa a
quantidade no plano e no recibo, inclusive no dryRun. Um evidence parcial so e
aceito quando count e request.records correspondem ao lote; arquivo remoto,
evidence de outro lote ou relatorio incompleto conservam resultado incerto.

Na resposta ODC, um evidence local valido decide antes de outcome e gate da
bridge. Uma falha parcial pode vir como gate_refused depois de gravar as linhas
boas: seus IDs e falhas por linha continuam autoritativos. Timeout com outcome
uncertain e gate studio_busy, ou native_error sem relatorio, ficam incertos.
Nao enviado exige prova, como sent:false, submitted:0, Studio ausente ou
gate_refused sem evidence, desde que o texto nao afirme "N of M records failed".
Essa afirmacao prova envio mesmo se WithoutStack cortar o caminho do evidence:
stack "at ...", prosa "at least..." ou valor PostgreSQL ecoado conservam uncertain.
Success com ID e texto de erro e contraditorio:
fica incerto nas duas faixas e nunca e reenviado automaticamente, nem por
reconciliacao de keys na mesma carga.

A reserva por entidade protege cargas que ainda podem progredir, incluindo
continuacoes por prazo ou cancelamento. `ok:false` sozinho nunca libera a reserva.
Falhas com linhas restantes, not-submitted, pending apos processo morto, uncertain
com keys, erros transitorios de leitura/tenant e argumento trocado continuam
resumable. Uma retomada sem palavras usa as do plano (load-authorization-from-plan).
A resposta incerta de uma carga com keys declara `outcome:"reconcilable"`: a
mesma chamada a reconcilia relendo as keys. next e continuation apontam a mesma acao segura
(retomada original ou previa de encerramento), e outra carga recebe a dona. As keys das linhas failed
sao relidas antes de retomar, como as de linhas ainda nao enviadas.

Somente completed ou closed libera uma reserva que ja enviou dados. Nao existe
mais encerramento automatico por incerteza sem keys: arquivos exigem keys.
Todo estado retomavel tem saida explicita na mesma ferramenta e operationId:
`close:{preview:true}` lista por arquivo/linha successfulRows, failedRows,
uncertainRows, notSentRows e unchangedRows, contagens e sha256 do snapshot.
Depois de revisar, `close:{previewSha256,authorize}` exige as palavras do dono
dadas depois da previa, nunca vistas antes, com o numero de linhas que ficam sem
escrita (falhas + incertas + nunca enviadas), pelo menos 5 s depois da previa; a
continuation da previa nao carrega as palavras da carga. Grava closed e libera a reserva. Previa desatualizada exige revisar nova previa.
Arquivo editado, falha deterministica, cancelamento e reconciliacao ambigua ou
contraditoria oferecem esse caminho; nenhuma confirmacao e presumida. Fechar
nao desfaz dados e nao transforma incerteza em falha. Qualquer retomada closed
recebe DATA_LOAD_CLOSED com receiptFile e linhas preservadas, sem nova escrita.
PID morto recupera a trava de execucao, mas nao abandona a reserva resumable.
Uma reserva sem plano validado e sem envio cujo processo morreu (insert/update
inline morto na chamada nativa, ou carga morta antes de plan.json) e removida pela
proxima chamada; com o dono vivo, BUSY diz `ownerHasPlan:false` e a saida e repetir
a mesma chamada. A maquina
de estados completa esta em [CX13-CICLO-CARGA.md](CX13-CICLO-CARGA.md).

Reconciliacao bem-sucedida por keys limpa nativeOk, code e error transitorios
do lote concluido. O historico nativo fica no diario, sem contaminar ok:true
com DATA_OUTCOME_UNKNOWN ou "do not retry" no recibo final.

Uma recusa na retomada informa written a partir do diario e aponta receiptFile
da carga original; nao afirma zero escritas quando lotes anteriores ja gravaram.
Se a carga ainda e resumable, siga a continuation para retomar ou revisar o encerramento;
nao abra outra carga enquanto a antiga ainda puder escrever. Uma carga closed
exige inspecao do efeito real antes de uma carga nova com keys. No discover,
abrir/abra/open/reabrir/reopen nao sao verbos de carga. O insert por arquivo
exige carregar/load/importar e fonte explicita; formato, destino arquivo e
fonte de registros sao vetados por gramatica de leitura/exportacao, nao por
frases prontas. Palavras save/salvar/export como valores de dados nao vetam carga.

## Usuarios e papeis (pacote de 06/10, A13)

`o11_data` continua recusando os modulos (System) e Users, para leitura e escrita.
Eles guardam usuarios, papeis e hashes de senha.

Para achar um usuario ou os papeis dele, use `o11_access {action:"users", email?, username?, role?, max?}`.
E so leitura e nao leva palavras. Le `User`, `Role` e `User_Role` pelo Edit Data do Studio
com lista fechada: id, username, nome, email, ativo e nomes de papel. Nunca senha nem hash.
Detalhes em `docs/OPERACOES-O11.md` (secao de usuarios e papeis).

## Implementacao e prova

GitSSAM foi consultado como referencia do contrato. A implementacao nova usa
tipos do cliente nativo instalado, sem copiar o codigo legado ou decompilado.
Modulo, entidade e atributos passam obrigatoriamente por `Keys.ToDb`.
A chave base64 do modelo provocava 404; a mesma chamada com DatabaseValue/GUID
retornou HTTP 200 nas 18 entidades do Astra1_CS. Nao era falta de endpoint.

O tipo concreto de entidade vem de `GetInterface().Name`: o objeto interno do
Studio implementa varias interfaces; `is IStaticEntity` sozinho classifica
entidades persistentes incorretamente. Ha regressao especifica para esse caso.

Build isolado, sem substituir DLL de worker/Studio em uso:

```powershell
dotnet build kernel/src/Anvil.Cli -c Release -o kernel/.local/data-cli
dotnet test kernel/tests/Anvil.Tests -c Release --filter FullyQualifiedName~EntityDataTests
node --test platforms/odc/facade/tests/lanes.test.mjs
```

A fachada escolhe o CLI mais recente entre o build normal e data-cli. O MCP
carrega `o11_data` na proxima inicializacao/conexao do servidor; o CLI funciona
imediatamente. Nao foi necessario trocar a bridge carregada.

Prova em 2026-09-18: seis testes .NET e tres testes da fachada passaram.
Carga Astra1: 7 Horse, 7 HorsePhoto (1.575.907 bytes), 21 HorseQuirk e 6
DemoDistance. Campos e FKs conferidos; hashes SHA256 das sete fotos iguais aos
arquivos de origem. Segunda carga: nenhuma escrita e mesmas contagens.
Evidencias locais em `.local/astra1-seed/data/verification.json`, `seed-proof.json`
e `receipts/`; leitura pela entrada publica em `.local/astra1-seed/public-cli.log`.
Os 29 registros estaticos preexistentes foram apenas lidos.

CRUD nativo tambem provado: insercao de um registro temporario de teste,
atualizacao com acentos e emoji, releitura exata, repeticao do mesmo operationId
sem reenvio e exclusao confirmada. A tabela voltou aos 21 registros do seed.
Recibo de verificacao: `.local/astra1-seed/data/crud-verification.json`.

Isso comprova dados e transporte; os testes funcionais de swipe/match/chat
continuam sendo uma validacao separada. Nenhum fluxo do aplicativo foi alterado.
