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
